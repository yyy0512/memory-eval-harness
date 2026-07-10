```java
package com.circleconnect.nexus.service.influence;

import com.circleconnect.nexus.domain.Circle;
import com.circleconnect.nexus.domain.Member;
import com.circleconnect.nexus.domain.enumeration.ActionType;
import com.circleconnect.nexus.events.MemberInfluenceScoreChangedEvent;
import com.circleconnect.nexus.repository.ActionLogRepository;
import com.circleconnect.nexus.repository.CircleRepository;
import com.circleconnect.nexus.repository.MemberRepository;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.github.resilience4j.ratelimiter.RateLimiter;
import io.github.resilience4j.ratelimiter.RateLimiterConfig;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

/**
 * InfluenceScoreService
 * ------------------------------------------------------
 * Centralised service that keeps member–influence scores
 * up-to-date for every circle in the system.  Scores are
 * affected by user-generated actions such as creating
 * posts, pledging funds, voting, or moderating content.
 *
 * The service leverages:
 *  • RateLimiter      – shields the database against N-sized
 *                       action bursts from the same member
 *  • Caffeine Cache   – reduces redundant recomputations
 *  • Spring Scheduler – performs batched writes in a
 *                       dedicated flush cadence
 *
 * Thread-safety notes:
 *  • Pending actions are collected in a lock-free queue.
 *  • Reads are cached; writes are serialised by the flush
 *    method being executed in a single-threaded scheduler.
 */
@Service
@Slf4j
public class InfluenceScoreService {

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * Configurable weights for each ActionType, adjustable via the admin
     * panel at runtime (values cached for 30s).
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    private static final Cache<ActionType, Double> WEIGHT_CACHE =
            Caffeine.newBuilder()
                    .expireAfterWrite(Duration.ofSeconds(30))
                    .maximumSize(32)
                    .build();

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * Flush cadence & backlog storage
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    private final ConcurrentLinkedQueue<WeightedAction> backlog = new ConcurrentLinkedQueue<>();

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * Infrastructure
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    private final MemberRepository memberRepository;
    private final CircleRepository circleRepository;
    private final ActionLogRepository actionLogRepository;
    private final ApplicationEventPublisher eventPublisher;
    private final RateLimiter actionRateLimiter;

    public InfluenceScoreService(MemberRepository memberRepository,
                                 CircleRepository circleRepository,
                                 ActionLogRepository actionLogRepository,
                                 ApplicationEventPublisher eventPublisher) {

        this.memberRepository = memberRepository;
        this.circleRepository = circleRepository;
        this.actionLogRepository = actionLogRepository;
        this.eventPublisher = eventPublisher;

        // Prevent excessive influence updates by a single member
        this.actionRateLimiter = RateLimiter.of(
            "influence-score-update",
            RateLimiterConfig.custom()
                    .limitForPeriod(20)               // no more than 20 updates
                    .limitRefreshPeriod(Duration.ofMinutes(1))
                    .timeoutDuration(Duration.ofMillis(250))
                    .build());
    }

    /* ================================================================
     * PUBLIC API
     * ============================================================== */

    /**
     * Registers a new user action for influence-scoring. The call is
     * asynchronous and fast; expensive recomputations are delayed to
     * the scheduler-driven flush().
     */
    public void registerAction(long memberId,
                               long circleId,
                               ActionType actionType,
                               Instant occurredAt) {

        // Ensure we're not being abused
        if (!actionRateLimiter.acquirePermission()) {
            log.debug("Rate-limited influence-action for member {}", memberId);
            return;
        }

        // Load action weight (cached)
        double weight = WEIGHT_CACHE.get(actionType, this::loadWeightFor);

        backlog.offer(new WeightedAction(memberId, circleId, actionType, occurredAt, weight));

        log.trace("Queued influence action: member={}, circle={}, type={}", memberId, circleId, actionType);
    }

    /* ================================================================
     * SCHEDULER
     * ============================================================== */

    /**
     * Flushes pending actions every 15 seconds, batching multiple
     * operations into one transactional write.
     */
    @Scheduled(fixedDelay = 15_000)
    @Transactional
    public void flush() {
        if (backlog.isEmpty()) {
            return;
        }

        // Aggregate deltas per (circle, member)
        Map<AggregateKey, Double> deltas = new java.util.HashMap<>(32);
        WeightedAction action;
        while ((action = backlog.poll()) != null) {
            AggregateKey key = new AggregateKey(action.getMemberId(), action.getCircleId());
            deltas.merge(key, action.getWeight(), Double::sum);
        }

        // Persist aggregates
        for (Map.Entry<AggregateKey, Double> entry : deltas.entrySet()) {
            AggregateKey key = entry.getKey();
            double delta = entry.getValue();

            Optional<Member> memberOpt = memberRepository.findById(key.memberId);
            Optional<Circle> circleOpt = circleRepository.findById(key.circleId);

            if (memberOpt.isEmpty() || circleOpt.isEmpty()) {
                log.warn("Discarding influence update – invalid FK (member={}, circle={})",
                        key.memberId, key.circleId);
                continue;
            }

            Member member = memberOpt.get();

            double newScore = member.getInfluenceScore() + delta;
            member.setInfluenceScore(newScore);
            memberRepository.save(member); // dirty-checking flush

            // Create audit log
            actionLogRepository.saveInfluenceChange(
                    member.getId(), key.circleId, delta, newScore, Instant.now());

            // Domain event for reactive views
            eventPublisher.publishEvent(new MemberInfluenceScoreChangedEvent(
                    this, member.getId(), key.circleId, newScore));

            log.debug("Influence score updated: member={}, circle={}, +{}/->{}",
                    member.getId(), key.circleId, delta, newScore);
        }
    }

    /* ================================================================
     * Weight Source
     * ============================================================== */

    /**
     * Loads weight for an {@link ActionType} from the database or falls
     * back to the embedded defaults when the admin table is empty.
     */
    private double loadWeightFor(ActionType type) {
        return actionLogRepository
                .findWeightForActionType(type)
                .orElseGet(() -> embeddedDefaults().get(type));
    }

    /**
     * Hard-coded baseline weights – intentionally package-private for
     * testing visibility.
     */
    static Map<ActionType, Double> embeddedDefaults() {
        Map<ActionType, Double> defaults = new EnumMap<>(ActionType.class);
        defaults.put(ActionType.POST_CREATE, 1.5);
        defaults.put(ActionType.POST_REACTION, 0.5);
        defaults.put(ActionType.PLEDGE_PAYMENT, 3.0);
        defaults.put(ActionType.EVENT_RSVP, 1.0);
        defaults.put(ActionType.VOTE_CAST, 0.75);
        defaults.put(ActionType.EVENT_MODERATION, 1.25);
        return defaults;
    }

    /* ================================================================
     * Value Objects
     * ============================================================== */

    @Data
    @AllArgsConstructor
    private static class WeightedAction {
        private final long memberId;
        private final long circleId;
        private final ActionType actionType;
        private final Instant occurredAt;
        private final double weight;
    }

    /**
     * AggregateKey merges member & circle ids; must be hashable.
     */
    private record AggregateKey(long memberId, long circleId) {
        @Override public int hashCode() { return Objects.hash(memberId, circleId); }
    }
}
```