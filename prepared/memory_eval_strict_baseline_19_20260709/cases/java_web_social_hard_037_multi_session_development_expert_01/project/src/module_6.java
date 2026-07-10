package com.circleconnect.nexus.analytics;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import javax.annotation.PostConstruct;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Service responsible for calculating and caching per–member influence scores
 * inside a circle. These scores drive content visibility, badge attribution,
 * and other social incentives across the platform.
 *
 * <p>The class is intentionally kept self-contained to make the algorithm easy
 * to evolve without rippling changes across controllers or repositories.</p>
 */
@Service
public class module_6 {

    private static final Logger LOG = LoggerFactory.getLogger(module_6.class);

    private final PostRepository postRepository;
    private final VoteRepository voteRepository;
    private final Cache          influenceCache;
    private final Duration       cacheTtl;

    @Autowired
    public module_6(PostRepository postRepository,
                    VoteRepository voteRepository,
                    CacheManager cacheManager,
                    @Value("${nexus.analytics.cache-ttl-minutes:30}") long ttlMinutes) {

        this.postRepository  = Objects.requireNonNull(postRepository,  "postRepository must not be null");
        this.voteRepository  = Objects.requireNonNull(voteRepository,  "voteRepository must not be null");
        this.influenceCache  = Objects.requireNonNull(cacheManager.getCache("influence-scores"),
                                                      "Cache 'influence-scores' must be configured");
        this.cacheTtl        = Duration.ofMinutes(ttlMinutes);
    }

    /* ------------------------------------------------------------------
     * Public API
     * ------------------------------------------------------------------ */

    /**
     * Returns an influence score for a single member/circle pair. The method
     * first checks the cache before performing any database work.
     */
    @Transactional(readOnly = true)
    public InfluenceScore getInfluenceScore(UUID memberId, UUID circleId) {

        InfluenceCacheKey key = new InfluenceCacheKey(memberId, circleId);
        InfluenceScore cached = influenceCache.get(key, InfluenceScore.class);

        if (cached != null && !cached.isStale(cacheTtl)) {
            return cached;
        }

        InfluenceScore computed = computeScore(memberId, circleId);
        influenceCache.put(key, computed);
        return computed;
    }

    /**
     * Batched recomputation executed by a scheduler. Keeps the cache warm for
     * the most frequently accessed scores without blocking user requests.
     */
    @Scheduled(cron = "${nexus.analytics.recompute-cron:0 */15 * * * *}") // every 15 minutes by default
    @Transactional(readOnly = true)
    public void recomputeAllInfluenceScores() {

        try {
            LOG.info("Starting scheduled influence score recomputation");

            List<PostActivitySnapshot> snapshots = postRepository.fetchRecentPostActivitySnapshot();
            Map<InfluenceCacheKey, MutableScore> buffers = new ConcurrentHashMap<>();

            // Aggregate raw activity rows into intermediate scores
            snapshots.forEach(snapshot -> {
                InfluenceCacheKey key = new InfluenceCacheKey(snapshot.getAuthorId(), snapshot.getCircleId());
                buffers.computeIfAbsent(key, k -> new MutableScore()).accumulate(snapshot);
            });

            // Transform intermediate model into immutable value objects
            buffers.forEach((key, buffer) ->
                    influenceCache.put(key, buffer.toImmutable(key.memberId, key.circleId)));

            LOG.info("Finished scheduled influence score recomputation. {} scores refreshed", buffers.size());

        } catch (DataAccessException dae) {
            LOG.error("Database failure during influence score recomputation", dae);
        } catch (Exception ex) {
            LOG.error("Unexpected error during influence score recomputation", ex);
        }
    }

    /* ------------------------------------------------------------------
     * Core computation logic
     * ------------------------------------------------------------------ */

    private InfluenceScore computeScore(UUID memberId, UUID circleId) {

        try {
            int     postCount   = postRepository.countByAuthorAndCircle(memberId, circleId);
            int     likes       = voteRepository.sumValueByTargetAuthorAndCircle(memberId, circleId);
            Instant lastPostAt  = postRepository.findLastPostTimestamp(memberId, circleId).orElse(Instant.EPOCH);

            double postsWeight   = 1.5;
            double likesWeight   = 1.0;
            double recencyWeight = 2.0;

            double recencyBoost = 1 / (1 + Math.exp(Duration.between(lastPostAt, Instant.now()).toHours() / 24.0));

            double rawScore = (postsWeight   * postCount)
                            + (likesWeight   * likes)
                            + (recencyWeight * recencyBoost);

            return new InfluenceScore(memberId, circleId, rawScore, Instant.now(), false);

        } catch (DataAccessException dae) {
            LOG.error("Failed to compute influence score for member {} in circle {}", memberId, circleId, dae);
            return InfluenceScore.error(memberId, circleId);
        }
    }

    /* ------------------------------------------------------------------
     * Internal value objects & helpers
     * ------------------------------------------------------------------ */

    /**
     * Cache key wrapper to avoid collisions and clarify intent.
     */
    private static final class InfluenceCacheKey {
        final UUID memberId;
        final UUID circleId;

        InfluenceCacheKey(UUID memberId, UUID circleId) {
            this.memberId = memberId;
            this.circleId = circleId;
        }

        @Override public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof InfluenceCacheKey)) return false;
            InfluenceCacheKey that = (InfluenceCacheKey) o;
            return Objects.equals(memberId, that.memberId)
                && Objects.equals(circleId, that.circleId);
        }

        @Override public int hashCode() {
            return Objects.hash(memberId, circleId);
        }
    }

    /**
     * Immutable score object exposed to callers. Marked final to guarantee thread-safety.
     */
    public static final class InfluenceScore {

        private final UUID    memberId;
        private final UUID    circleId;
        private final double  score;
        private final Instant calculatedAt;
        private final boolean error;

        private InfluenceScore(UUID memberId,
                               UUID circleId,
                               double score,
                               Instant calculatedAt,
                               boolean error) {
            this.memberId    = memberId;
            this.circleId    = circleId;
            this.score       = score;
            this.calculatedAt = calculatedAt;
            this.error       = error;
        }

        static InfluenceScore error(UUID memberId, UUID circleId) {
            return new InfluenceScore(memberId, circleId, 0.0, Instant.now(), true);
        }

        public UUID    getMemberId()    { return memberId; }
        public UUID    getCircleId()    { return circleId; }
        public double  getScore()       { return score; }
        public Instant getCalculatedAt(){ return calculatedAt; }
        public boolean isError()        { return error; }

        boolean isStale(Duration ttl) {
            return calculatedAt.plus(ttl).isBefore(Instant.now());
        }

        @Override
        public String toString() {
            return "InfluenceScore{" +
                   "memberId="    + memberId +
                   ", circleId="  + circleId +
                   ", score="     + score +
                   ", calculatedAt=" + calculatedAt +
                   ", error="     + error +
                   '}';
        }
    }

    /**
     * Internal mutable builder used during batch aggregation to minimize object churn.
     */
    private static final class MutableScore {

        private int     postCount;
        private int     likes;
        private Instant mostRecentPost = Instant.EPOCH;

        void accumulate(PostActivitySnapshot snapshot) {
            postCount += snapshot.getPostCount();
            likes     += snapshot.getTotalLikes();
            if (snapshot.getLastPostAt().isAfter(mostRecentPost)) {
                mostRecentPost = snapshot.getLastPostAt();
            }
        }

        InfluenceScore toImmutable(UUID memberId, UUID circleId) {

            double postsWeight   = 1.5;
            double likesWeight   = 1.0;
            double recencyWeight = 2.0;

            double recencyBoost = 1 / (1 + Math.exp(Duration.between(mostRecentPost, Instant.now()).toHours() / 24.0));

            double rawScore = (postsWeight   * postCount)
                            + (likesWeight   * likes)
                            + (recencyWeight * recencyBoost);

            return new InfluenceScore(memberId, circleId, rawScore, Instant.now(), false);
        }
    }

    /* ------------------------------------------------------------------
     * Repository abstractions (simplified for brevity)
     * ------------------------------------------------------------------ */

    public interface PostRepository {

        int countByAuthorAndCircle(UUID memberId, UUID circleId);

        Optional<Instant> findLastPostTimestamp(UUID memberId, UUID circleId);

        List<PostActivitySnapshot> fetchRecentPostActivitySnapshot();
    }

    public interface VoteRepository {

        int sumValueByTargetAuthorAndCircle(UUID memberId, UUID circleId);
    }

    /**
     * Projection interface returned by custom JPQL/native queries.
     */
    public interface PostActivitySnapshot {

        UUID    getAuthorId();
        UUID    getCircleId();
        int     getPostCount();
        int     getTotalLikes();
        Instant getLastPostAt();
    }
}