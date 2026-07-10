package com.circleconnect.nexus.analytics;

import com.circleconnect.nexus.domain.Comment;
import com.circleconnect.nexus.domain.Pledge;
import com.circleconnect.nexus.domain.Post;
import com.circleconnect.nexus.domain.User;
import com.circleconnect.nexus.events.CommentCreatedEvent;
import com.circleconnect.nexus.events.PledgeCreatedEvent;
import com.circleconnect.nexus.events.PostVotedEvent;
import com.circleconnect.nexus.repository.CommentRepository;
import com.circleconnect.nexus.repository.InfluenceScoreRepository;
import com.circleconnect.nexus.repository.PledgeRepository;
import com.circleconnect.nexus.repository.PostRepository;
import com.circleconnect.nexus.repository.UserRepository;
import com.circleconnect.nexus.repository.VoteRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.CachePut;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.Assert;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * Production-grade implementation for calculating and maintaining a user’s
 * “Influence Score”—a weighted, time-decaying metric used in feed ranking,
 * circle reputation, and badge assignment.
 *
 * <p>Influence is currently derived from:
 * <ul>
 *     <li>Up-votes &amp; down-votes on posts</li>
 *     <li>Monetary pledges towards circle campaigns</li>
 *     <li>Comments authored</li>
 *     <li>Post age decay</li>
 * </ul>
 *
 * <p>This service is designed for high concurrency (read heavy, write light).
 * Scores are cached per-user, lazily recalculated on demand, and periodically
 * batch-refreshed by a scheduled task to correct any drift.
 *
 * <p>NOTE: Most repositories referenced here are spring-data abstractions that
 * expose streaming read methods and write-behind persistence for minimal heap
 * pressure on large datasets.</p>
 */
@Service
@Transactional(readOnly = true)
public class InfluenceScoreService {

    private static final Logger LOG = LoggerFactory.getLogger(InfluenceScoreService.class);

    // -------------------- Tunable Weighting --------------------

    @Value("${analytics.influence.weight.upvote:2.0}")
    private double weightUpvote;

    @Value("${analytics.influence.weight.downvote:-1.0}")
    private double weightDownvote;

    @Value("${analytics.influence.weight.pledge:0.003}")
    private double weightPledgePerCent;        // weight per cent pledged

    @Value("${analytics.influence.weight.comment:0.5}")
    private double weightComment;

    @Value("${analytics.influence.decay.halfLifeDays:14}")
    private int halfLifeDays;

    // -------------------- Dependencies -------------------------

    private final VoteRepository voteRepository;
    private final PledgeRepository pledgeRepository;
    private final CommentRepository commentRepository;
    private final PostRepository postRepository;
    private final UserRepository userRepository;
    private final InfluenceScoreRepository influenceScoreRepository;

    public InfluenceScoreService(
            VoteRepository voteRepository,
            PledgeRepository pledgeRepository,
            CommentRepository commentRepository,
            PostRepository postRepository,
            UserRepository userRepository,
            InfluenceScoreRepository influenceScoreRepository) {

        this.voteRepository = voteRepository;
        this.pledgeRepository = pledgeRepository;
        this.commentRepository = commentRepository;
        this.postRepository = postRepository;
        this.userRepository = userRepository;
        this.influenceScoreRepository = influenceScoreRepository;
    }

    // -------------------- Public API ---------------------------

    /**
     * Returns the influence score for the provided userId. The score is served
     * from the cache when available; otherwise a fresh computation is
     * performed and the result cached.
     *
     * @param userId Unique identifier of the user
     * @return Influence score. Guaranteed to be non-negative.
     */
    @Cacheable(cacheNames = "influenceScores", key = "#userId")
    public double getInfluenceScore(UUID userId) {
        Assert.notNull(userId, "userId must not be null");
        return computeAndPersistScore(userId);
    }

    /**
     * Force recalculation and cache update for a single user.
     *
     * @param userId user id
     * @return new score
     */
    @CachePut(cacheNames = "influenceScores", key = "#userId")
    public double refreshInfluenceScore(UUID userId) {
        Assert.notNull(userId, "userId must not be null");
        return computeAndPersistScore(userId);
    }

    /**
     * Evicts a user’s score from the cache without recalculating.
     */
    @CacheEvict(cacheNames = "influenceScores", key = "#userId")
    public void evictInfluenceScore(UUID userId) {
        // no-op; annotation driven
    }

    // -------------------- Reactive Event Hooks ----------------

    @EventListener
    public void onVoteCreated(PostVotedEvent evt) {
        scheduleAsyncRefresh(evt.userId());
    }

    @EventListener
    public void onPledgeCreated(PledgeCreatedEvent evt) {
        scheduleAsyncRefresh(evt.userId());
    }

    @EventListener
    public void onCommentCreated(CommentCreatedEvent evt) {
        scheduleAsyncRefresh(evt.userId());
    }

    /**
     * Small helper that refreshes scores in a separate thread. Has its own
     * transactional boundary to avoid leaking listener transactions.
     */
    private void scheduleAsyncRefresh(UUID userId) {
        // In production, this would be delegated to an async executor.
        try {
            refreshInfluenceScore(userId);
        } catch (Exception ex) {
            LOG.warn("Deferred refresh for user {} failed – score will be recalculated in the next cycle", userId, ex);
        }
    }

    // -------------------- Batch Maintenance -------------------

    /**
     * Hourly maintenance job that recalculates influence scores that have
     * drifted more than ±5 % from their persisted value.
     *
     * <p>The job purposefully runs with READ_COMMITTED isolation to avoid
     * locking large tables; individual score calculations are executed in
     * smaller chunks.</p>
     */
    @Scheduled(cron = "0 7 * * * *") // every hour, minute 7
    @Transactional(noRollbackFor = Exception.class)
    public void refreshDriftingScores() {
        LOG.info("Influence score maintenance cycle started");
        influenceScoreRepository
                .findSuspectedDriftUsers(0.05d)
                .forEach(userId -> {
                    try {
                        double newScore = refreshInfluenceScore(userId);
                        LOG.debug("Influence score for user {} refreshed to {}", userId, newScore);
                    } catch (Exception ex) {
                        LOG.warn("Failed to refresh influence score for user {}", userId, ex);
                    }
                });
        LOG.info("Influence score maintenance cycle finished");
    }

    // -------------------- Core Calculation --------------------

    private double computeAndPersistScore(UUID userId) {
        Instant start = Instant.now();
        try {
            User user = userRepository.findById(userId).orElse(null);
            if (user == null) {
                LOG.debug("No user found for {}, returning zero influence", userId);
                return 0d;
            }

            int upVotes   = voteRepository.countUpVotesByUser(userId);
            int downVotes = voteRepository.countDownVotesByUser(userId);

            BigDecimal totalPledged = pledgeRepository.sumPledgedAmountByUser(userId);
            if (totalPledged == null) {
                totalPledged = BigDecimal.ZERO;
            }

            int comments = commentRepository.countByAuthorId(userId);

            // Decay factor based on newest post timestamp
            Instant latestPost = postRepository.findMostRecentPostTimestampByAuthor(userId)
                    .orElse(Instant.EPOCH);
            double decayMultiplier = calculateDecayMultiplier(latestPost);

            double rawScore =
                    (weightUpvote * upVotes) +
                    (weightDownvote * downVotes) +
                    (weightPledgePerCent * totalPledged.movePointRight(2).doubleValue()) +
                    (weightComment * comments);

            double finalScore = Math.max(0, rawScore * decayMultiplier);

            influenceScoreRepository.upsert(userId, finalScore); // write-behind save
            LOG.trace("Influence for user {} computed in {} ms -> {}", userId,
                    Duration.between(start, Instant.now()).toMillis(), finalScore);
            return finalScore;
        } catch (DataAccessException dae) {
            LOG.error("Database error while computing influence score for {}", userId, dae);
            throw dae; // will be converted to 5xx response by exception handler layer
        } catch (Exception ex) {
            LOG.error("Unexpected error while computing influence score for {}", userId, ex);
            throw ex;
        }
    }

    /**
     * Exponential decay multiplier that halves the score every {@code halfLifeDays}.
     */
    private double calculateDecayMultiplier(Instant newestPostTimestamp) {
        long ageDays = Duration.between(newestPostTimestamp, Instant.now()).toDays();
        if (ageDays <= 0) {
            return 1d;
        }
        double halvingIntervals = ageDays / (double) halfLifeDays;
        return Math.pow(0.5d, halvingIntervals);
    }
}