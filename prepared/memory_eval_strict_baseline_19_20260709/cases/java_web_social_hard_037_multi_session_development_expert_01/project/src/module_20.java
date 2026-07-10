```java
package com.circleconnect.nexus.modules.analytics;

import com.circleconnect.nexus.domain.circle.Circle;
import com.circleconnect.nexus.domain.member.CircleMember;
import com.circleconnect.nexus.domain.member.MemberInfluenceSnapshot;
import com.circleconnect.nexus.domain.post.Post;
import com.circleconnect.nexus.infrastructure.events.DomainEventPublisher;
import com.circleconnect.nexus.infrastructure.exceptions.ConcurrentExecutionException;
import com.circleconnect.nexus.infrastructure.repositories.CircleMemberRepository;
import com.circleconnect.nexus.infrastructure.repositories.CircleRepository;
import com.circleconnect.nexus.infrastructure.repositories.MemberInfluenceSnapshotRepository;
import com.circleconnect.nexus.infrastructure.repositories.PostRepository;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.DoubleSummaryStatistics;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * InfluenceScoreService
 *
 * Production–grade analytics component responsible for computing and persisting
 * the "influence score" for every member inside a circle. The influence score drives
 * several high–level product features:
 *   • content visibility ordering
 *   • eligibility for circle moderation
 *   • tie-breaking in funding goals
 *
 * Heavy safety measures (distributed locking, timeouts, cache, transactional boundaries)
 * are employed to ensure that large recalculation runs never compromise the system.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class InfluenceScoreService {

    private static final String LOCK_PREFIX = "circle:influence:recalc:";
    private static final int MAX_EXECUTION_MINUTES = 5;

    // We hold a tiny, short-lived cache that protects us from hammering
    // Redis with locking requests when multiple nodes try to recalc the same circle.
    private final Cache<UUID, Instant> recentRecalcCache = Caffeine.newBuilder()
            .expireAfterWrite(Duration.ofMinutes(2))
            .maximumSize(10_000)
            .build();

    private final CircleRepository circleRepository;
    private final CircleMemberRepository memberRepository;
    private final PostRepository postRepository;
    private final MemberInfluenceSnapshotRepository snapshotRepository;
    private final DomainEventPublisher eventPublisher;
    private final RedissonClient redissonClient;

    /**
     * Entrypoint triggered by Spring's task scheduler every two minutes.
     * The scheduler is intentionally lightweight and only selects circles
     * that have had "activity" in the past hour.
     */
    @Scheduled(fixedDelay = 120_000)
    public void recalculateForActiveCircles() {
        List<Circle> activeCircles = circleRepository.findActiveSince(Instant.now().minus(Duration.ofHours(1)));
        if (activeCircles.isEmpty()) {
            log.debug("No active circles found for influence recalculation.");
            return;
        }

        activeCircles.forEach(circle -> {
            try {
                recalculateInfluenceScores(circle.getId());
            } catch (Exception ex) {
                log.error("Failed to recalculate influence scores for circle={}. Error={}",
                          circle.getId(), ex.getMessage(), ex);
            }
        });
    }

    /**
     * Public API for synchronous recalculation of one single Circle.
     * Consumers can call this method when important events occur
     * (e.g., a large import or a new voting cycle).
     *
     * @param circleId ID of the target circle
     */
    @Transactional
    public void recalculateInfluenceScores(UUID circleId) {
        // Fast memory guard –— bail out if we have recalculated too recently
        if (recentRecalcCache.getIfPresent(circleId) != null) {
            log.debug("Recalc skipped; was executed <2m ago for circle={}", circleId);
            return;
        }

        // Distributed lock to ensure multi-node exclusivity
        RLock lock = redissonClient.getLock(buildLockKey(circleId));
        boolean granted = false;
        try {
            granted = lock.tryLock(2, MAX_EXECUTION_MINUTES, TimeUnit.MINUTES);
            if (!granted) {
                throw new ConcurrentExecutionException("Could not obtain recalculation lock for circle=" + circleId);
            }

            doRecalculation(circleId);
            // Snapshot completion time so that we throttle recalcs
            recentRecalcCache.put(circleId, Instant.now());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ConcurrentExecutionException("Lock wait interrupted for circle=" + circleId, interrupted);
        } finally {
            if (granted && lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }

    /* --------------- Internal worker section ---------------- */

    private void doRecalculation(UUID circleId) {
        Circle circle = circleRepository.findById(circleId)
                .orElseThrow(() -> new IllegalArgumentException("Circle not found: " + circleId));

        List<CircleMember> members = memberRepository.findByCircleId(circleId);
        if (members.isEmpty()) {
            log.warn("Circle {} contains no members; influence recalculation aborted.", circleId);
            return;
        }

        // Pre-fetch posts for the circle only once
        List<Post> circlePosts = postRepository.findByCircleId(circleId);

        members.forEach(member -> {
            double score = computeInfluenceScore(member, circlePosts);
            persistSnapshot(circle, member, score);
        });

        // Publish event for downstream projections and cache warmers
        eventPublisher.publish(new InfluenceScoresUpdatedEvent(circleId));
        log.info("Influence scores finished for circle={}, membersProcessed={}", circleId, members.size());
    }

    /**
     * Core scoring algorithm – this can be expanded at will
     * without breaking the service outer contract.
     */
    private double computeInfluenceScore(CircleMember member, List<Post> circlePosts) {
        long authoredPosts = circlePosts.stream()
                .filter(p -> p.getAuthorId().equals(member.getMemberId()))
                .count();

        DoubleSummaryStatistics voteStats = circlePosts.stream()
                .flatMap(p -> p.getVotes().stream())
                .filter(v -> v.getVoterId().equals(member.getMemberId()))
                .mapToDouble(v -> v.getValue()) // +1, -1, etc.
                .summaryStatistics();

        long attendance = member.getAttendedEvents(); // domain field

        // Weighted sum – coefficients tweaked during product experimentation
        double score = authoredPosts * 3.0
                       + voteStats.getSum() * 1.5
                       + attendance * 2.0
                       + member.getReputation() * 0.8;

        // Apply time decay – newer activity overrides older
        Duration membershipAge = Duration.between(member.getJoinedAt(), Instant.now());
        double decayMultiplier = 1.0 / (1.0 + (membershipAge.toDays() / 180.0));
        score *= decayMultiplier;

        return score;
    }

    private void persistSnapshot(Circle circle, CircleMember member, double score) {
        // Keep only the most recent snapshot per day
        Optional<MemberInfluenceSnapshot> existing = snapshotRepository
                .findRecentForMember(member.getMemberId());

        if (existing.isPresent()
            && existing.get().getCreatedAt().isAfter(Instant.now().minus(Duration.ofHours(12)))) {
            // Performance guard: update in-place instead of insert
            MemberInfluenceSnapshot snapshot = existing.get();
            snapshot.setScore(score);
            snapshot.setVersion(snapshot.getVersion() + 1);
            snapshotRepository.save(snapshot);
        } else {
            MemberInfluenceSnapshot snapshot = MemberInfluenceSnapshot.of(
                    UUID.randomUUID(),
                    circle.getId(),
                    member.getMemberId(),
                    score,
                    Instant.now());
            snapshotRepository.save(snapshot);
        }
    }

    private static String buildLockKey(UUID circleId) {
        return LOCK_PREFIX + circleId.toString();
    }

    /* --------------- Event Class ---------------- */

    /**
     * Domain event fired once a circle has a fresh generation
     * of influence scores. Other bounded contexts listen:
     *   • Feed service – to recalculate ranking
     *   • Moderator service – to refresh eligibility
     *   • Analytics pipeline – to export metrics
     */
    public static class InfluenceScoresUpdatedEvent {

        private final UUID circleId;

        public InfluenceScoresUpdatedEvent(UUID circleId) {
            this.circleId = circleId;
        }

        public UUID getCircleId() {
            return circleId;
        }
    }

}
```