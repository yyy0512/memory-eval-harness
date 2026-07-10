```java
/*
 * CircleConnect Nexus – Influence Score Service
 *
 * This component encapsulates the algorithm and orchestration logic that
 * calculates, caches, and periodically re-evaluates the “influence score”
 * of content items (posts) inside a circle.  Influence scores are consumed
 * by the feed-ranking engine and admin analytics panels, and are therefore
 * considered performance-critical.  The implementation leverages:
 *
 *   • Spring Cache abstraction for aggressive in-memory caching
 *   • Spring’s @Scheduled facility for background recalculation
 *   • JPA repositories for persistence I/O
 *   • Optimistic locking and defensive error handling for robustness
 *
 * NOTE: Several domain entities (Post, Circle, User, Reaction, Pledge) as
 * well as repository interfaces (PostRepository, ReactionRepository, …)
 * are assumed to be declared elsewhere in the code-base.
 */

package com.circleconnectnexus.social.service;

import com.circleconnectnexus.social.domain.Circle;
import com.circleconnectnexus.social.domain.Post;
import com.circleconnectnexus.social.domain.User;
import com.circleconnectnexus.social.events.PledgeCreatedEvent;
import com.circleconnectnexus.social.events.ReactionCreatedEvent;
import com.circleconnectnexus.social.repository.PledgeRepository;
import com.circleconnectnexus.social.repository.PostRepository;
import com.circleconnectnexus.social.repository.ReactionRepository;
import jakarta.persistence.LockModeType;
import jakarta.persistence.OptimisticLockException;
import jakarta.transaction.Transactional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.CachePut;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.ApplicationListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

@Service
public class InfluenceScoreService
        implements InitializingBean,
                   ApplicationListener<ReactionCreatedEvent>,
                   ApplicationListener<PledgeCreatedEvent> {

    private static final Logger LOG = LoggerFactory.getLogger(InfluenceScoreService.class);

    private final PostRepository postRepository;
    private final ReactionRepository reactionRepository;
    private final PledgeRepository pledgeRepository;
    private final CacheManager cacheManager;

    @Value("${circleconnect.influence.decay-half-life-hours:24}")
    private long decayHalfLifeHours;

    @Value("${circleconnect.influence.reaction-weight:1.0}")
    private double reactionWeight;

    @Value("${circleconnect.influence.pledge-weight:2.5}")
    private double pledgeWeight;

    @Value("${circleconnect.influence.author-karma-weight:0.5}")
    private double authorKarmaWeight;

    public InfluenceScoreService(PostRepository postRepository,
                                 ReactionRepository reactionRepository,
                                 PledgeRepository pledgeRepository,
                                 CacheManager cacheManager) {
        this.postRepository   = Objects.requireNonNull(postRepository);
        this.reactionRepository = Objects.requireNonNull(reactionRepository);
        this.pledgeRepository   = Objects.requireNonNull(pledgeRepository);
        this.cacheManager       = Objects.requireNonNull(cacheManager);
    }

    /* ----------------------------------------------------------------------
     * Public API
     * -------------------------------------------------------------------- */

    /**
     * Calculates an up-to-date influence score for the given post.  Results
     * are cached; callers who require a hard refresh can invoke
     * {@link #recalculateAndCache(long)} explicitly.
     *
     * @param postId the identifier of the post
     * @return influence score, zero if post does not exist
     */
    @Cacheable(value = "postInfluenceScore", key = "#postId")
    public double getInfluenceScore(long postId) {
        return postRepository.findById(postId)
                .map(this::doCalculateInfluenceScore)
                .orElse(0.0d);
    }

    /**
     * Hard-refreshes influence score, bypassing the “read-through” cache.  Meant
     * to be used by event handlers or administrative tools.
     */
    @CachePut(value = "postInfluenceScore", key = "#postId")
    public double recalculateAndCache(long postId) {
        return postRepository.findById(postId)
                .map(post -> {
                    double score = doCalculateInfluenceScore(post);
                    LOG.debug("Re-calculated influenceScore={} for postId={}", score, postId);
                    return score;
                })
                .orElse(0.0d);
    }

    /* ----------------------------------------------------------------------
     * Scheduled maintenance – keeps cache “warm” for trending posts
     * -------------------------------------------------------------------- */

    /**
     * Periodically refresh top-N posts to avoid cold cache penalties on
     * the main feed endpoints.
     */
    @Scheduled(fixedDelayString = "${circleconnect.influence.hot-cache-refresh-ms:300000}")
    public void warmCacheForTrendingPosts() {
        try {
            List<Post> hottest = postRepository.findTopNByOrderByLastInteractionDesc(100);
            hottest.stream()
                   .parallel()
                   .forEach(post -> {
                       try {
                           recalculateAndCache(post.getId());
                       } catch (Exception e) {
                           LOG.warn("Failed to warm cache for post #{}", post.getId(), e);
                       }
                   });
        } catch (Exception ex) {
            LOG.error("Failed to warm influence cache for trending posts", ex);
        }
    }

    /* ----------------------------------------------------------------------
     * Domain Event Handling
     * -------------------------------------------------------------------- */

    /**
     * On new reactions, we refresh the score of the affected post.
     */
    @Override
    public void onApplicationEvent(ReactionCreatedEvent event) {
        long postId = event.getPostId();
        LOG.debug("REACTION event detected – refreshing influence for post={}", postId);
        recalculateAndCache(postId);
    }

    /**
     * On new pledges, pledges carry heavier weight and should influence
     * score instantly.
     */
    @Override
    public void onApplicationEvent(PledgeCreatedEvent event) {
        long postId = event.getPostId();
        LOG.debug("PLEDGE event detected – refreshing influence for post={}", postId);
        recalculateAndCache(postId);
    }

    /* ----------------------------------------------------------------------
     * Evict cache when underlying entities are modified/deleted elsewhere
     * -------------------------------------------------------------------- */

    @CacheEvict(value = "postInfluenceScore", key = "#postId")
    public void evictCache(long postId) {
        // Intentionally empty – annotation does all the work.
    }

    /* ----------------------------------------------------------------------
     * Internal implementation
     * -------------------------------------------------------------------- */

    /**
     * Primary influence algorithm, distilled from product spec v3.8.
     *
     *   score =
     *       (reactionWeight * upVotes)
     *     + (pledgeWeight   * pledgeCount)
     *     + (authorKarmaWeight * authorKarma)
     *     * decayFactor
     *
     * decayFactor = 0.5 ^ (ageHours / decayHalfLifeHours)
     */
    private double doCalculateInfluenceScore(Post post) {

        long upVotes     = reactionRepository.countPositiveReactions(post.getId());
        long pledgeCount = pledgeRepository.countDistinctByPostId(post.getId());
        User author      = post.getAuthor();
        double authorKarma = Optional.ofNullable(author)
                .map(User::getKarmaScore)
                .orElse(0.0d);

        double rawScore = (reactionWeight     * upVotes)
                        + (pledgeWeight       * pledgeCount)
                        + (authorKarmaWeight  * authorKarma);

        long hoursSinceCreation = Duration.between(
                post.getCreatedAt(),
                Instant.now()).toHours();

        double decayFactor = Math.pow(0.5d, hoursSinceCreation / (double) decayHalfLifeHours);

        double finalScore = rawScore * decayFactor;

        if (LOG.isTraceEnabled()) {
            LOG.trace("Post={}  upVotes={} pledge={} karma={} → raw={} decay={} => final={}",
                    post.getId(), upVotes, pledgeCount, authorKarma, rawScore, decayFactor, finalScore);
        }
        return finalScore;
    }

    /* ----------------------------------------------------------------------
     * Lifecycle
     * -------------------------------------------------------------------- */

    @Override
    public void afterPropertiesSet() {
        LOG.info("InfluenceScoreService initialized ‑ halfLife={}h reactionWeight={} pledgeWeight={}",
                 decayHalfLifeHours, reactionWeight, pledgeWeight);
    }

    /* ----------------------------------------------------------------------
     * Transactional utility wrappers
     * -------------------------------------------------------------------- */

    /**
     * Safely increments “lastInteraction” timestamp on a post to maintain
     * ordering guarantees for the trending query. Uses optimistic locking
     * to avoid hot-spot contention.
     */
    @Transactional
    public void touchPostInteraction(long postId) {
        try {
            postRepository.findByIdWithLock(postId, LockModeType.OPTIMISTIC)
                    .ifPresent(post -> {
                        post.setLastInteraction(Instant.now());
                        postRepository.save(post);
                    });
        } catch (OptimisticLockException optimisticEx) {
            // Benign – indicates a concurrent update has already occurred.
            LOG.debug("Optimistic lock lost while touching post #{}", postId);
        } catch (Exception unexpected) {
            LOG.error("Failed to touch interaction timestamp for post #{}", postId, unexpected);
        }
    }
}
```