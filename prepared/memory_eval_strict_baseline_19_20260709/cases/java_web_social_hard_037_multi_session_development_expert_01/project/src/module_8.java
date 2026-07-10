package com.circleconnect.nexus.analytics;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.circleconnect.nexus.domain.Circle;
import com.circleconnect.nexus.domain.CircleMember;
import com.circleconnect.nexus.domain.Post;
import com.circleconnect.nexus.domain.Pledge;
import com.circleconnect.nexus.repository.CircleRepository;
import com.circleconnect.nexus.repository.PledgeRepository;
import com.circleconnect.nexus.repository.PostRepository;

/**
 * InfluenceScoreService is responsible for computing and caching the “influence score”
 * of every member within a Circle.  Scores are re-calculated on a schedule and whenever
 * a cache-miss occurs.  The algorithm is intentionally opinionated but highly
 * configurable via Spring {@code application.yaml} properties.
 *
 * <p>Algorithm outline:
 * <ul>
 *     <li>Each post, comment, vote, and pledge contributes a weighted amount.</li>
 *     <li>An exponential time-decay is applied to de-emphasize older activity.</li>
 *     <li>Scores are normalized to a 0-100 range.</li>
 *     <li>All results are cached in-memory for fast retrieval.</li>
 * </ul>
 *
 * Thread-safety is provided by a {@link ConcurrentHashMap} and by keeping cached maps
 * immutable via {@link Collections#unmodifiableMap(Map)}.
 */
@Service
public class InfluenceScoreService {

    private static final Logger LOG = LoggerFactory.getLogger(InfluenceScoreService.class);

    /* ---------- Dependencies ---------- */

    private final CircleRepository circleRepository;
    private final PostRepository   postRepository;
    private final PledgeRepository pledgeRepository;

    /* ---------- Configuration ---------- */

    @Value("${analytics.influence.weight.post:1.0}")
    private double postWeight;

    @Value("${analytics.influence.weight.comment:0.6}")
    private double commentWeight;

    @Value("${analytics.influence.weight.vote:0.8}")
    private double voteWeight;

    @Value("${analytics.influence.weight.pledge:1.4}")
    private double pledgeWeight;

    @Value("${analytics.influence.decay.half-life-days:30}")
    private long halfLifeDays;

    /* ---------- In-memory cache ---------- */

    /**
     * A map keyed by {@code circleId -> (memberId -> score)}.
     * The inner map is immutable to prevent accidental mutation outside this service.
     */
    private final Map<UUID, Map<UUID, Double>> circleScoreCache = new ConcurrentHashMap<>();

    /* ---------- Constructor ---------- */

    public InfluenceScoreService(CircleRepository circleRepository,
                                 PostRepository postRepository,
                                 PledgeRepository pledgeRepository) {

        this.circleRepository = Objects.requireNonNull(circleRepository, "circleRepository must not be null");
        this.postRepository   = Objects.requireNonNull(postRepository,   "postRepository must not be null");
        this.pledgeRepository = Objects.requireNonNull(pledgeRepository, "pledgeRepository must not be null");
    }

    /* ---------- Public API ---------- */

    /**
     * Returns the influence scores for the supplied circle.  The values are served from
     * cache when available; otherwise, the score map is computed synchronously.
     */
    public Map<UUID, Double> getScores(UUID circleId) {
        return circleScoreCache.computeIfAbsent(circleId, this::calculateScores);
    }

    /**
     * Explicitly invalidates the cached score map for a single circle—useful when
     * membership mutates outside normal activity flows.
     */
    public void invalidate(UUID circleId) {
        circleScoreCache.remove(circleId);
    }

    /**
     * Clears the entire influence-score cache.
     */
    public void invalidateAll() {
        circleScoreCache.clear();
    }

    /* ---------- Scheduled execution ---------- */

    /**
     * Recalculates influence scores for every active circle on a fixed cron schedule.
     * The default expression (“0 */15 * * * *”) executes every 15 min.
     */
    @Scheduled(cron = "${analytics.influence.recompute.cron:0 */15 * * * *}")
    @Transactional(readOnly = true)
    public void recomputeAll() {
        LOG.debug("Starting scheduled influence-score recomputation");
        List<UUID> circleIds = circleRepository.findAllActiveCircleIds();
        circleIds.forEach(id -> {
            try {
                circleScoreCache.put(id, calculateScores(id));
            } catch (Exception ex) {
                LOG.error("Failed to compute influence scores for circle {}", id, ex);
            }
        });
        LOG.debug("Completed influence-score recomputation for {} circles", circleIds.size());
    }

    /* ---------- Core computation ---------- */

    /**
     * Performs the heavy-lifting for influence-score calculation.  The method is marked
     * {@code protected} for easier unit/integration testing.
     */
    @Transactional(readOnly = true)
    protected Map<UUID, Double> calculateScores(UUID circleId) {

        Circle circle = circleRepository.findById(circleId)
                .orElseThrow(() -> new IllegalArgumentException("Circle not found: " + circleId));

        Instant now    = Instant.now();
        double  lambda = Math.log(2) / Duration.ofDays(halfLifeDays).toSeconds();

        Map<UUID, Double> accumulator = new HashMap<>();

        /* ---- Posts, comments & votes ---- */

        for (Post post : postRepository.findAllByCircleId(circleId)) {
            double postContribution = postWeight * decay(post.getCreatedAt(), now, lambda);
            add(accumulator, post.getAuthorId(), postContribution);

            // Comments (assuming Post::getComments returns a collection)
            post.getComments().forEach(comment -> {
                double c = commentWeight * decay(comment.getCreatedAt(), now, lambda);
                add(accumulator, comment.getAuthorId(), c);
            });

            // Votes (assuming Post::getVotes returns a collection)
            post.getVotes().forEach(vote -> {
                double v = voteWeight *
                           (vote.isUp() ? 1 : -1) *
                           decay(vote.getCreatedAt(), now, lambda);
                add(accumulator, vote.getVoterId(), v);
            });
        }

        /* ---- Pledges ---- */

        for (Pledge pledge : pledgeRepository.findAllByCircleId(circleId)) {
            double p = pledgeWeight *
                       pledge.getAmount().doubleValue() *
                       decay(pledge.getCreatedAt(), now, lambda);
            add(accumulator, pledge.getMemberId(), p);
        }

        /* ---- Normalization & zero-fill ---- */

        normalizeToPercentage(accumulator);

        // Ensure members with zero activity still show up in the UI.
        circle.getMembers().stream()
              .map(CircleMember::getUserId)
              .filter(id -> !accumulator.containsKey(id))
              .forEach(id -> accumulator.put(id, 0.0));

        return Collections.unmodifiableMap(accumulator);
    }

    /* ---------- Helper methods ---------- */

    private static void add(Map<UUID, Double> map, UUID key, double value) {
        map.merge(key, value, Double::sum);
    }

    private static double decay(Instant timestamp, Instant now, double lambda) {
        long secondsAgo = Math.max(0, Duration.between(timestamp, now).toSeconds());
        return Math.exp(-lambda * secondsAgo);
    }

    /**
     * Scales all values so that the maximum becomes 100 %.  Values are rounded to one
     * decimal for readability.
     */
    private static void normalizeToPercentage(Map<UUID, Double> map) {
        double max = map.values().stream().mapToDouble(Double::doubleValue).max().orElse(1.0);
        if (max == 0) return;

        map.replaceAll((k, v) -> Math.round((v / max * 100.0) * 10.0) / 10.0);
    }
}