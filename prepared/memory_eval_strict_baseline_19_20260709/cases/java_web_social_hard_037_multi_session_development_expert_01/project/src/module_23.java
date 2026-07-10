```java
package com.circleconnect.nexus.domain.engagement;

import com.circleconnect.nexus.domain.events.CircleEvent;
import com.circleconnect.nexus.domain.events.PostCreatedEvent;
import com.circleconnect.nexus.domain.events.PledgeCreatedEvent;
import com.circleconnect.nexus.domain.events.VoteCastEvent;
import com.circleconnect.nexus.domain.exceptions.ResourceNotFoundException;
import com.circleconnect.nexus.domain.model.CircleMember;
import com.circleconnect.nexus.domain.model.Post;
import com.circleconnect.nexus.domain.repositories.CircleMemberRepository;
import com.circleconnect.nexus.domain.repositories.PledgeRepository;
import com.circleconnect.nexus.domain.repositories.PostRepository;
import com.circleconnect.nexus.domain.repositories.VoteRepository;
import com.google.common.util.concurrent.RateLimiter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * InfluenceScoreService is the single source of truth for calculating and
 * retrieving a member’s influence score within a circle.
 * <p>
 * The score is recalculated whenever relevant domain events occur
 * (posts, votes, pledges) and persisted to the database in an eventually
 * consistent fashion. A scheduled full back-fill runs nightly to mitigate
 * drift between incremental updates and the ground truth.
 *
 * <p>Formula (simplified):
 *
 * score = Σ(postWeight * postCount)
 *       + Σ(voteWeight * votesCast)
 *       + Σ(pledgeWeight * pledgeAmountNormalized)
 *
 * <p>
 * This implementation demonstrates:
 *  - Incremental, event-driven score updates
 *  - Guava RateLimiter to guard expensive operations
 *  - Scheduled task for full recompute
 *  - Spring Cache abstraction to offload hot reads
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InfluenceScoreService {

    private final CircleMemberRepository memberRepository;
    private final PostRepository postRepository;
    private final VoteRepository voteRepository;
    private final PledgeRepository pledgeRepository;
    private final ApplicationEventPublisher publisher;
    private final CacheManager cacheManager;

    // Defensive local cache to avoid thundering herd in edge cases
    private final ConcurrentMap<UUID, Double> inMemoryHotCache = new ConcurrentHashMap<>(1_024);

    // Rate-limit heavy recalculations to 5 permits / sec
    private final RateLimiter heavyOpRateLimiter = RateLimiter.create(5.0);

    // Cache name defined in CacheConfig
    private static final String INFLUENCE_SCORE_CACHE = "influence-scores";

    // Weights are subject to A/B testing, kept configurable
    private static final double POST_WEIGHT   = 2.0;
    private static final double VOTE_WEIGHT   = 0.75;
    private static final double PLEDGE_WEIGHT = 0.25;

    /**
     * Returns an up-to-date influence score, possibly served from cache.
     *
     * @param memberId the target member UUID
     * @return the influence score
     */
    public double getInfluenceScore(UUID memberId) {
        Cache cache = cacheManager.getCache(INFLUENCE_SCORE_CACHE);
        if (cache != null) {
            Double cached = cache.get(memberId, Double.class);
            if (cached != null) {
                return cached;
            }
        }

        // Fall back to in-memory hot cache
        Double hotCached = inMemoryHotCache.get(memberId);
        if (hotCached != null) {
            return hotCached;
        }

        // As a last resort, recalculate synchronously (rate-limited)
        heavyOpRateLimiter.acquire();
        double score = recalculateInfluenceScore(memberId);
        persistAndCache(memberId, score);
        return score;
    }

    /**
     * Forces an influence-score recomputation for a given member.
     * Used by admin panel and nightly maintenance tasks.
     */
    @Transactional
    public double recalculateInfluenceScore(UUID memberId) {
        CircleMember member = memberRepository.findById(memberId)
                .orElseThrow(() -> new ResourceNotFoundException("Member not found: " + memberId));

        long postCount = postRepository.countByAuthorId(memberId);
        long votesCast = voteRepository.countByVoterId(memberId);
        BigDecimal pledged = pledgeRepository.sumActivePledgeAmountsByMemberId(memberId)
                .orElse(BigDecimal.ZERO);

        double score = POST_WEIGHT   * postCount
                     + VOTE_WEIGHT   * votesCast
                     + PLEDGE_WEIGHT * pledged.doubleValue();

        log.debug("Recalculated influence score for member {}: {}", memberId, score);
        return score;
    }

    /**
     * Persists the computed score and populates the multi-tier cache.
     */
    @Transactional
    public void persistAndCache(UUID memberId, double score) {
        memberRepository.updateInfluenceScore(memberId, score);
        inMemoryHotCache.put(memberId, score);

        Cache cache = cacheManager.getCache(INFLUENCE_SCORE_CACHE);
        if (cache != null) {
            cache.put(memberId, score);
        }

        publisher.publishEvent(new InfluenceScoreUpdatedEvent(this, memberId, score));
        log.info("Influence score persisted for member {}: {}", memberId, score);
    }

    /* ------------------------------------------------------------------
     * Domain-event listeners for incremental updates
     * ------------------------------------------------------------------ */

    @EventListener
    public void onPostCreated(PostCreatedEvent event) {
        updateScoreAsync(event, POST_WEIGHT);
    }

    @EventListener
    public void onVoteCast(VoteCastEvent event) {
        updateScoreAsync(event, VOTE_WEIGHT);
    }

    @EventListener
    public void onPledgeCreated(PledgeCreatedEvent event) {
        updateScoreAsync(event, PLEDGE_WEIGHT);
    }

    /**
     * Asynchronously bumps the score with a delta rather than full recompute.
     */
    private void updateScoreAsync(CircleEvent event, double weight) {
        UUID memberId = event.getMemberId();

        // Non-blocking, minimal transaction
        double delta = computeDelta(event, weight);
        memberRepository.incrementInfluenceScore(memberId, delta);

        // Invalidate caches
        inMemoryHotCache.remove(memberId);
        Cache cache = cacheManager.getCache(INFLUENCE_SCORE_CACHE);
        if (cache != null) {
            cache.evict(memberId);
        }

        log.debug("Incremental influence delta applied for member {}: {}", memberId, delta);
    }

    private double computeDelta(CircleEvent event, double weight) {
        if (event instanceof PledgeCreatedEvent p) {
            return weight * p.getAmount().doubleValue();
        }
        // Posts/Votes each count as 1 occurrence multiplied by weight
        return weight;
    }

    /* ------------------------------------------------------------------
     * Scheduled full back-fill (03:17 UTC every night)
     * ------------------------------------------------------------------ */
    @Scheduled(cron = "0 17 3 * * *")
    public void nightlyFullRecompute() {
        Instant started = Instant.now();
        log.info("Nightly influence recompute started at {}", started);

        memberRepository.streamAllMemberIds().forEach(memberId -> {
            try {
                double score = recalculateInfluenceScore(memberId);
                persistAndCache(memberId, score);
            } catch (Exception ex) {
                log.error("Failed to recompute influence score for {}", memberId, ex);
            }
        });

        Duration duration = Duration.between(started, Instant.now());
        log.info("Nightly influence recompute finished after {}", duration);
    }

    /* ------------------------------------------------------------------
     * Event emitted after influence score update
     * ------------------------------------------------------------------ */
    public record InfluenceScoreUpdatedEvent(Object source,
                                             UUID memberId,
                                             double newScore) { }
}
```