package com.circleconnect.nexus.feed;

import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.*;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.repository.query.Param;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.lang.NonNull;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import javax.persistence.*;
import javax.validation.Valid;
import javax.validation.constraints.Max;
import javax.validation.constraints.Min;
import javax.validation.constraints.NotNull;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * The code in this file aggregates, caches, and rate-limits
 * circle feed retrieval operations.  All classes are kept in a
 * single compilation unit so that the file can stand on its own
 * while remaining fully functional when dropped into a Spring
 * Boot application that already has component scanning enabled.
 *
 * NOTE:  The public class name intentionally matches the file
 * name to satisfy the Java compiler.  Although the lowercase
 * style defies common conventions, it is perfectly legal.
 */
public class module_4 {

    /* *************************************************************
     *  CONTROLLER LAYER
     * *************************************************************/

    @RestController
    @RequestMapping("/api/v1/circles/{circleId}/feed")
    @Validated
    public static class CircleFeedController {

        private final CircleFeedService feedService;

        public CircleFeedController(CircleFeedService feedService) {
            this.feedService = feedService;
        }

        /**
         * Returns a paginated, influence-sorted feed for the circle.
         * All requests are transparently rate-limited (see service).
         */
        @GetMapping
        public ResponseEntity<FeedResponse> fetchFeed(
                @PathVariable @NotNull UUID circleId,
                @RequestParam(defaultValue = "0") @Min(0) int page,
                @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
                @RequestHeader(name = "X-User-Id") @NotNull UUID userId) {

            Page<PostDto> posts = feedService.getFeed(circleId, userId, PageRequest.of(page, size));
            FeedResponse response = new FeedResponse(posts.getContent(), posts.getNumber(),
                                                     posts.getTotalElements(), posts.getTotalPages());

            return ResponseEntity.ok(response);
        }
    }

    /* *************************************************************
     *  SERVICE LAYER
     * *************************************************************/

    @Service
    public static class CircleFeedService {

        private static final Logger log = LoggerFactory.getLogger(CircleFeedService.class);

        private final PostRepository postRepository;
        private final InfluenceService influenceService;

        @Value("${circle.feed.cache.seconds:30}")
        private long cacheTtlSeconds;

        public CircleFeedService(PostRepository postRepository,
                                 InfluenceService influenceService) {
            this.postRepository = postRepository;
            this.influenceService = influenceService;
        }

        /**
         * Retrieves a page of posts for the given circle, ordered by
         * a composite “score” (currently: influence weight + recency).
         * <p>
         * The method is
         * <ul>
         *     <li>Read-only transactional – database is never mutated.</li>
         *     <li>Cached – identical requests within {@code cacheTtlSeconds}
         *         are served from memory.</li>
         *     <li>Rate-limited – protects against abusive scraping.</li>
         * </ul>
         */
        @Cacheable(
                cacheNames = "circleFeed",
                key = "{ #circleId, #pageable.pageNumber, #pageable.pageSize }")
        @RateLimiter(name = "circleFeedLimiter")
        @Transactional(readOnly = true)
        public Page<PostDto> getFeed(@NonNull UUID circleId,
                                     @NonNull UUID userId,
                                     @NonNull Pageable pageable) {

            try {
                Page<Post> posts = postRepository.findByCircleId(circleId, pageable);

                // Enrich posts with influence-weighted scores
                List<PostDto> dtos = posts.getContent().stream()
                        .map(p -> toDto(p, userId))
                        .sorted(Comparator.comparingDouble(PostDto::getScore).reversed())
                        .collect(Collectors.toList());

                return new PageImpl<>(dtos, pageable, posts.getTotalElements());
            } catch (DataAccessException ex) {
                log.error("Failed to fetch feed for circle {}: {}", circleId, ex.getMessage(), ex);
                throw new FeedRetrievalException("Unable to load circle feed", ex);
            }
        }

        /**
         * Clears all cached feeds.  The job runs at fixed intervals to
         * ensure hot data does not become stale when new posts arrive.
         * The eviction rate can be tuned via application properties.
         */
        @Scheduled(fixedRateString = "${circle.feed.cache.evict.millis:45000}")
        @CacheEvict(cacheNames = "circleFeed", allEntries = true)
        public void evictCaches() {
            log.debug("Evicted ‘circleFeed’ cache.");
        }

        /* -------------------  Helpers  ------------------- */

        private PostDto toDto(Post post, UUID userId) {
            double influenceWeight = influenceService.weightForUser(userId, post.getAuthorId());
            double score = computeScore(post.getCreatedAt(), influenceWeight);
            return new PostDto(post.getId(), post.getAuthorId(), post.getContent(),
                               post.getCreatedAt(), influenceWeight, score);
        }

        private double computeScore(Instant createdAt, double influenceWeight) {
            long secondsSincePost = Math.max(1, Instant.now().getEpochSecond() - createdAt.getEpochSecond());
            // Very simple hotness algorithm: influenceWeight / log(time+2)
            return influenceWeight / Math.log(secondsSincePost + 2);
        }
    }

    /* *************************************************************
     *  REPOSITORY LAYER
     * *************************************************************/

    interface PostRepository extends PagingAndSortingRepository<Post, UUID> {

        @Query("SELECT p FROM Post p WHERE p.circleId = :circleId")
        Page<Post> findByCircleId(@Param("circleId") UUID circleId, Pageable pageable);
    }

    /* *************************************************************
     *  DOMAIN / DTO
     * *************************************************************/

    @Entity
    @Table(name = "posts")
    class Post {

        @Id
        private UUID id;

        @Column(name = "circle_id", nullable = false)
        private UUID circleId;

        @Column(name = "author_id", nullable = false)
        private UUID authorId;

        @Column(nullable = false, length = 8192)
        private String content;

        @Column(name = "created_at", nullable = false)
        private Instant createdAt;

        /* Getters only, to maintain immutability after construction */

        public UUID getId() { return id; }
        public UUID getCircleId() { return circleId; }
        public UUID getAuthorId() { return authorId; }
        public String getContent() { return content; }
        public Instant getCreatedAt() { return createdAt; }
    }

    /**
     * Render-ready Post DTO returned by the REST controller.
     */
    record PostDto(UUID id,
                   UUID authorId,
                   String content,
                   Instant createdAt,
                   double influenceWeight,
                   double score) { }

    /**
     * Wrapper that makes paging metadata explicit to the client.
     */
    record FeedResponse(List<PostDto> posts, int page, long totalElements, int totalPages) { }

    /* *************************************************************
     *  SUPPORTING COMPONENTS
     * *************************************************************/

    /**
     * Example influence service.  In production this would consult
     * reputation tables, machine-learning models, etc.
     */
    @Component
    class InfluenceService {

        @Value("${circle.feed.influence.defaultWeight:1.0}")
        private double defaultWeight;

        public double weightForUser(@NonNull UUID requestingUser,
                                    @NonNull UUID authorUser) {
            // Simplified: prefer posts by friends & self
            if (requestingUser.equals(authorUser)) {
                return defaultWeight * 2;
            }
            // TODO: inject FriendshipService and compute actual weight
            return defaultWeight;
        }
    }

    /* *************************************************************
     *  CUSTOM EXCEPTIONS
     * *************************************************************/

    /**
     * Thrown when obtaining the feed fails due to infrastructure issues.
     */
    @ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
    static class FeedRetrievalException extends RuntimeException {
        FeedRetrievalException(String message, Throwable cause) { super(message, cause); }
    }
}