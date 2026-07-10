```java
package com.circleconnect.nexus.modules.engagement;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;

import javax.annotation.PostConstruct;
import javax.persistence.EntityNotFoundException;
import javax.transaction.Transactional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.Trigger;
import org.springframework.scheduling.TriggerContext;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import net.javacrumbs.shedlock.spring.annotation.EnableSchedulerLock;
import net.javacrumbs.shedlock.spring.annotation.SchedulerLock;

/**
 * Aggregates everything related to influence-score computation under a single compilation
 * unit so that the file name `module_16.java` does not clash with Java’s
 * “one-public-class-per-file” restriction.
 *
 * NOTE: All repository types referenced here already exist in the code-base
 * and are injected via Spring’s DI container at runtime.
 */
public class Module16 {

    /**
     * Service in charge of (re)computing a user’s influence score.
     * <p>
     * Influence score is a composite metric that represents how much a member
     * impacts the conversation inside every circle.  It is derived from:
     * <ul>
     *     <li>Original content (posts, comments)</li>
     *     <li>Positive reactions (votes, endorsements)</li>
     *     <li>Financial commitment (pledges)</li>
     *     <li>Time decay (<i>newer</i> interactions weigh more than older ones)</li>
     * </ul>
     *
     * Thread-safety: all mutating queries are executed inside the same transaction,
     * and heavy read operations are parallelised through an injected {@link Executor}.
     */
    @Service
    public static class InfluenceScoreService {

        private static final Logger log = LoggerFactory.getLogger(InfluenceScoreService.class);

        /* ---------- Tunable Weights (could be externalised to a config server) ---------- */
        private static final BigDecimal POST_WEIGHT   = BigDecimal.valueOf(3.0);
        private static final BigDecimal VOTE_WEIGHT   = BigDecimal.valueOf(1.5);
        private static final BigDecimal PLEDGE_WEIGHT = BigDecimal.valueOf(5.0);
        private static final BigDecimal DECAY_FACTOR  = BigDecimal.valueOf(0.83); // geometric decay

        private static final int BATCH_SIZE = 400;    // rows per DB page
        private static final BigDecimal MAX_SCORE = BigDecimal.valueOf(1000);

        /* ---------- Collaborators (Spring-managed) ---------- */
        private final UserRepository userRepository;
        private final PostRepository postRepository;
        private final VoteRepository voteRepository;
        private final PledgeRepository pledgeRepository;
        private final InfluenceScoreRepository scoreRepository;
        private final Executor executor;

        @Value("${nexus.influence.lookback-days:90}")
        private long lookbackDays;

        public InfluenceScoreService(
                UserRepository userRepository,
                PostRepository postRepository,
                VoteRepository voteRepository,
                PledgeRepository pledgeRepository,
                InfluenceScoreRepository scoreRepository,
                @Qualifier("influenceRecalculationExecutor") ObjectProvider<Executor> executorProvider) {

            this.userRepository      = userRepository;
            this.postRepository      = postRepository;
            this.voteRepository      = voteRepository;
            this.pledgeRepository    = pledgeRepository;
            this.scoreRepository     = scoreRepository;
            this.executor            = executorProvider.getIfAvailable(Runnable::run); // Fallback = synchronous
        }

        /**
         * Recompute the influence score of <strong>all</strong> active users.
         * Performs the work in batches & dispatches CPU-bound parts onto a
         * configurable {@link Executor}.
         */
        @Transactional
        public void recalculateAll() {
            LocalDateTime windowStart = LocalDateTime.now().minusDays(lookbackDays);
            log.info("Starting influence score recalculation (lookback={} days)", lookbackDays);

            int processed = 0;
            while (true) {
                List<UUID> userIds = userRepository.fetchActiveUserIds(PageRequest.of(0, BATCH_SIZE));
                if (userIds.isEmpty()) {
                    break;
                }
                CountDownLatch latch = new CountDownLatch(userIds.size());

                for (UUID id : userIds) {
                    CompletableFuture.runAsync(() -> {
                        try {
                            BigDecimal score = computeScoreForUser(id, windowStart);
                            updateScore(id, score);
                        } catch (Exception ex) {
                            log.error("Failed to compute influence for user={}", id, ex);
                        } finally {
                            latch.countDown();
                        }
                    }, executor);
                }

                try {
                    latch.await();
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Score recalculation interrupted", ie);
                }
                processed += userIds.size();
                log.debug("Processed {} users so far…", processed);
            }
            log.info("Influence score recalculation completed (total users processed={})", processed);
        }

        /* ---------- Internal Mechanics ---------- */

        /**
         * Computes the new influence score of a single user by analysing
         * all relevant signals since {@code windowStart}.
         */
        private BigDecimal computeScoreForUser(UUID userId, LocalDateTime windowStart) {
            UserProjection user = userRepository.findProjectionById(userId)
                    .orElseThrow(() -> new EntityNotFoundException("User not found: " + userId));

            long postCount   = postRepository.countByAuthorAndCreatedAtAfter(userId, windowStart);
            long voteCount   = voteRepository.countPositiveVotesForUserSince(userId, windowStart);
            long pledgeCount = pledgeRepository.countSuccessfulPledgesForUserSince(userId, windowStart);

            BigDecimal rawScore = BigDecimal.valueOf(postCount).multiply(POST_WEIGHT)
                    .add(BigDecimal.valueOf(voteCount).multiply(VOTE_WEIGHT))
                    .add(BigDecimal.valueOf(pledgeCount).multiply(PLEDGE_WEIGHT));

            long daysSinceJoin = Duration.between(user.getJoinedAt(), LocalDateTime.now()).toDays();
            BigDecimal decay   = DECAY_FACTOR.pow(Math.max(0, (int) daysSinceJoin / 30)); // monthly decay

            BigDecimal finalScore = rawScore.multiply(decay);
            if (finalScore.compareTo(MAX_SCORE) > 0) {
                finalScore = MAX_SCORE;
            }
            return finalScore.setScale(2, BigDecimal.ROUND_HALF_UP);
        }

        /**
         * Persists the newly computed score. Uses an <code>UPSERT</code>-style
         * query hidden behind {@link InfluenceScoreRepository} to avoid
         * database round-trips.
         */
        private void updateScore(UUID userId, BigDecimal score) {
            int rows = scoreRepository.updateScore(userId, score, LocalDateTime.now());
            if (rows == 0) {
                // Fall back to insert if the user does NOT have a score row yet.
                scoreRepository.insertScore(userId, score);
            }
            log.trace("Influence score for user={} is now {}", userId, score);
        }

        /* ---------- Testability helpers ---------- */
        @PostConstruct
        void _logExecutor() {
            log.info("InfluenceScoreService initialised with executor={}", executor.getClass().getSimpleName());
        }
    }

    /* -------------------------------------------------------------------------- */
    /* Scheduler                                                                  */
    /* -------------------------------------------------------------------------- */

    @Configuration
    @EnableScheduling
    @EnableSchedulerLock(defaultLockAtMostFor = "PT30M")
    @Import(InfluenceScoreService.class)
    public static class InfluenceScoreScheduler implements SmartLifecycle {

        private static final Logger log = LoggerFactory.getLogger(InfluenceScoreScheduler.class);

        private final InfluenceScoreService service;
        private volatile boolean running = false;

        public InfluenceScoreScheduler(InfluenceScoreService service) {
            this.service = service;
        }

        /**
         * Triggers a global recalculation on a fixed cron expression.  The schedule
         * can be overridden at runtime via <code>NEXUS_INFLUENCE_CRON</code> env var.
         */
        @SchedulerLock(name = "InfluenceScoreRecalculationJob")
        @Scheduled(cron = "${nexus.influence.cron:0 8,23 * * * *}") // 8 past & 23 past every hour
        public void scheduledRecompute() {
            try {
                service.recalculateAll();
            } catch (Exception ex) {
                log.error("Uncaught exception while recalculating influence scores", ex);
            }
        }

        /* ---------- SmartLifecycle implementation ---------- */

        @Override
        public void start() {
            running = true;
        }

        @Override
        public void stop() {
            running = false;
        }

        @Override
        public boolean isRunning() {
            return running;
        }

        @Override
        public int getPhase() {
            return Integer.MAX_VALUE; // start as late as possible
        }
    }

    /* -------------------------------------------------------------------------- */
    /* Repository projections & interfaces (signatures only).                     */
    /* -------------------------------------------------------------------------- */

    /** Lightweight projection to avoid fetching the whole User aggregate. */
    public interface UserProjection {
        UUID getId();
        LocalDateTime getJoinedAt();
    }

    // ----- Existing infrastructure; ONLY signatures are provided here -----
    interface UserRepository {
        List<UUID> fetchActiveUserIds(org.springframework.data.domain.Pageable page);
        java.util.Optional<UserProjection> findProjectionById(UUID id);
    }

    interface PostRepository {
        long countByAuthorAndCreatedAtAfter(UUID authorId, LocalDateTime createdAfter);
    }

    interface VoteRepository {
        long countPositiveVotesForUserSince(UUID userId, LocalDateTime since);
    }

    interface PledgeRepository {
        long countSuccessfulPledgesForUserSince(UUID userId, LocalDateTime since);
    }

    interface InfluenceScoreRepository {
        /**
         * Update score row. Returns affected row count (0 if absent).
         */
        int updateScore(UUID userId, BigDecimal score, LocalDateTime updatedAt);

        /**
         * Insert a new score row.
         */
        void insertScore(UUID userId, BigDecimal score);
    }
}
```