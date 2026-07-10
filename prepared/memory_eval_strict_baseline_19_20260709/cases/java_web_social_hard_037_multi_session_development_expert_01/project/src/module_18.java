```java
package com.circleconnect.nexus.analytics;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.validation.annotation.Validated;

import javax.validation.constraints.Min;
import javax.validation.constraints.NotNull;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * InfluenceScoreService is the central point for calculating and caching a member’s “influence score”
 * inside a given Circle.  The score is leveraged by several subsystems (feed ordering, badge awarding,
 * visibility rules, etc.) and therefore needs to be:
 *   1.  Quickly accessible (cached)
 *   2.  Consistent with recent user activity (frequently recalculated)
 *   3.  Resilient in the face of incomplete data (defensive programming)
 *
 * The service consolidates metrics from domain repositories (posts, pledges, reactions, votes, etc.),
 * applies a configurable weight‐matrix, and produces a single InfluenceScore value. The score is kept
 * in a local Caffeine cache for ultra-low-latency access, while background re‐computations keep the
 * cache fresh.
 *
 * NOTE: Repository interfaces referenced below are provided elsewhere in the CircleConnect codebase.
 */
@Service
@Validated
public class InfluenceScoreService {

    private static final Logger log = LoggerFactory.getLogger(InfluenceScoreService.class);

    // Default cache TTL set via application.yml or falls back to 10 minutes.
    private final Cache<String, InfluenceScore> cache;

    /* === Weight configuration (injected via Spring) ====================== */

    @Value("${circle.influence.weight.post:1.1}")
    private double postWeight;

    @Value("${circle.influence.weight.reaction:0.7}")
    private double reactionWeight;

    @Value("${circle.influence.weight.pledge:1.3}")
    private double pledgeWeight;

    @Value("${circle.influence.weight.vote:0.9}")
    private double voteWeight;

    /* === Repositories (resolved through component‐scan) ================== */

    private final PostRepository postRepository;
    private final ReactionRepository reactionRepository;
    private final PledgeRepository pledgeRepository;
    private final VoteRepository voteRepository;

    public InfluenceScoreService(PostRepository postRepository,
                                 ReactionRepository reactionRepository,
                                 PledgeRepository pledgeRepository,
                                 VoteRepository voteRepository,
                                 @Value("${circle.influence.cache.capacity:5000}") int maxCacheSize,
                                 @Value("${circle.influence.cache.ttl-minutes:10}") int ttlMinutes) {

        this.postRepository = Objects.requireNonNull(postRepository, "postRepository");
        this.reactionRepository = Objects.requireNonNull(reactionRepository, "reactionRepository");
        this.pledgeRepository = Objects.requireNonNull(pledgeRepository, "pledgeRepository");
        this.voteRepository = Objects.requireNonNull(voteRepository, "voteRepository");

        this.cache = Caffeine.newBuilder()
                .maximumSize(maxCacheSize)
                .expireAfterWrite(ttlMinutes, TimeUnit.MINUTES)
                .recordStats()
                .build();
    }

    /**
     * Returns an up-to-date influence score, using cache where possible.
     */
    @Transactional(readOnly = true)
    public InfluenceScore getInfluenceScore(@NotNull @Min(1) Long circleId,
                                            @NotNull @Min(1) Long memberId) {
        final String cacheKey = cacheKey(circleId, memberId);

        return cache.get(cacheKey, key -> {
            try {
                return computeInfluenceScore(circleId, memberId);
            } catch (Exception ex) {
                log.error("Failed to compute influence score for circle={} member={}", circleId, memberId, ex);
                return InfluenceScore.empty(circleId, memberId);
            }
        });
    }

    /**
     * Scheduled task that sweeps cache stats and periodically drops entries with
     * the lowest hit-ratio to keep memory bound predictable.
     * Executed every 30 minutes by default.
     */
    @Scheduled(fixedRateString = "${circle.influence.cache.rebalance-ms:1800000}")
    public void rebalanceCache() {
        log.debug("Rebalancing influence-score cache (currentSize={}, hitRate={})",
                cache.estimatedSize(), cache.stats().hitRate());
        cache.cleanUp();
    }

    /**
     * Scheduled batch recomputation to guarantee fresh data for active members.
     * This can run less frequently than the TTL to avoid stampede.
     */
    @Scheduled(cron = "${circle.influence.recompute.cron:0 0/15 * * * *}")
    @Transactional
    public void recomputeAllActiveMembers() {
        log.info("Triggering batch influence score recomputation for active members");

        // The query "findMembersActiveSince" is assumed to be paginated and stream-friendly.
        Instant threshold = Instant.now().minus(Duration.ofHours(4));
        voteRepository.findMembersActiveSince(threshold).forEach(activity -> {
            try {
                InfluenceScore newScore = computeInfluenceScore(activity.circleId(), activity.memberId());
                cache.put(cacheKey(activity.circleId(), activity.memberId()), newScore);
            } catch (Exception ex) {
                log.warn("Unable to recompute influence score for circle={} member={}",
                        activity.circleId(), activity.memberId(), ex);
            }
        });
    }

    /* ==================================================================== */
    /* ====================== Internal helper methods ===================== */
    /* ==================================================================== */

    private InfluenceScore computeInfluenceScore(Long circleId, Long memberId) {

        ActivityMetrics metrics = fetchMetrics(circleId, memberId);

        double weightedScore =
                (metrics.postCount()     * postWeight)     +
                (metrics.reactionCount() * reactionWeight) +
                (metrics.pledgeAmount()  * pledgeWeight)   +
                (metrics.voteCount()     * voteWeight);

        log.debug("Computed influence score={} for circle={} member={} [metrics={}]", weightedScore,
                circleId, memberId, metrics);

        return new InfluenceScore(circleId, memberId, weightedScore, Instant.now());
    }

    private ActivityMetrics fetchMetrics(Long circleId, Long memberId) {

        long posts      = postRepository.countByCircleIdAndAuthorId(circleId, memberId);
        long reactions  = reactionRepository.countByCircleIdAndMemberId(circleId, memberId);
        double pledges  = pledgeRepository.sumSuccessfulPledges(circleId, memberId).orElse(0.0);
        long votes      = voteRepository.countByCircleIdAndMemberId(circleId, memberId);

        return new ActivityMetrics(posts, reactions, pledges, votes);
    }

    private String cacheKey(Long circleId, Long memberId) {
        return circleId + ":" + memberId;
    }

    /* ==================================================================== */
    /* ============================  Records  ============================= */
    /* ==================================================================== */

    /**
     * Immutable DTO representing the calculated influence score.
     */
    public record InfluenceScore(Long circleId,
                                 Long memberId,
                                 double score,
                                 Instant calculatedAt) {

        public static InfluenceScore empty(Long circleId, Long memberId) {
            return new InfluenceScore(circleId, memberId, 0.0, Instant.now());
        }
    }

    /**
     * Aggregated activity metrics fetched from repositories.
     */
    private record ActivityMetrics(long postCount,
                                   long reactionCount,
                                   double pledgeAmount,
                                   long voteCount) {}

    /* ==================================================================== */
    /* ====================== Repository dependencies ===================== */
    /* ==================================================================== */

    /**
     * Package-private stubs representing infrastructure repositories.
     * Real implementations are provided elsewhere in the codebase via Spring Data JPA or similar.
     * These definitions are kept minimal to make this file compile independently.
     */
    interface PostRepository {
        long countByCircleIdAndAuthorId(Long circleId, Long authorId);
    }

    interface ReactionRepository {
        long countByCircleIdAndMemberId(Long circleId, Long memberId);
    }

    interface PledgeRepository {
        Optional<Double> sumSuccessfulPledges(Long circleId, Long memberId);
    }

    interface VoteRepository {

        long countByCircleIdAndMemberId(Long circleId, Long memberId);

        /**
         * Returns a finite stream of members that performed any voting activity since the given timestamp.
         * The tuple (circleId, memberId) identifies a unique member in a specific circle.
         */
        Iterable<MemberActivityRef> findMembersActiveSince(Instant since);
    }

    /**
     * Minimal value object used by VoteRepository#findMembersActiveSince.
     */
    record MemberActivityRef(Long circleId, Long memberId) {}
}
```