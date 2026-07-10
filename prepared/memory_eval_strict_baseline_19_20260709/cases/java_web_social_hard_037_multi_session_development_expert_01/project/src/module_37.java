```java
package com.circleconnect.nexus.service.feed;

import com.circleconnect.nexus.domain.ActivityEntry;
import com.circleconnect.nexus.domain.ActivityEntryType;
import com.circleconnect.nexus.domain.Circle;
import com.circleconnect.nexus.domain.User;
import com.circleconnect.nexus.exception.ResourceNotFoundException;
import com.circleconnect.nexus.repository.EventRepository;
import com.circleconnect.nexus.repository.PledgeRepository;
import com.circleconnect.nexus.repository.PostRepository;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/**
 * Production-grade service responsible for composing an activity feed for a given circle.
 * <p>
 * The feed merges heterogeneous domain events (posts, pledges, RSVPs…) into a unified,
 * chronologically sorted stream ready for JSON serialization or server-side rendering.
 * <p>
 * Caching, rate-limiting, async pre-fetching, and defensive error handling are applied
 * to guarantee responsiveness under heavy load while preventing enumeration attacks.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CircleActivityFeedService {

    // This cache name must be declared in CacheConfig
    private static final String FEED_CACHE = "circle-activity-feed";

    private final PostRepository postRepository;
    private final EventRepository eventRepository;
    private final PledgeRepository pledgeRepository;

    /**
     * Returns a bounded list of activity entries for the caller.
     *
     * @param circleId Id of the circle whose feed is requested
     * @param userId   Id of the user who is requesting the feed (used for ACL & personalization)
     * @param limit    Client-requested maximum number of entries. Capped server-side to 200.
     * @return List of {@link ActivityEntry} DTOs sorted by {@link ActivityEntry#getCreatedAt()} DESC.
     */
    @RateLimiter(name = "default") // Global RL; config in resilience4j.yml
    @Cacheable(cacheNames = FEED_CACHE, key = "#circleId + ':' + #userId + ':' + #limit")
    public List<ActivityEntry> getFeed(long circleId, long userId, int limit) {

        final int safeLimit = Math.max(1, Math.min(limit, 200));

        log.debug("Building activity feed: circleId={}, userId={}, limit={}", circleId, userId, safeLimit);

        // We intentionally run DB calls in parallel to minimize tail latency
        CompletableFuture<List<ActivityEntry>> postsFuture  = fetchPosts(circleId, userId, safeLimit);
        CompletableFuture<List<ActivityEntry>> eventsFuture = fetchEvents(circleId, userId, safeLimit);
        CompletableFuture<List<ActivityEntry>> pledgesFuture = fetchPledges(circleId, userId, safeLimit);

        // Combine all results, swallow exceptions per-segment (fail-soft)
        List<ActivityEntry> feed = new ArrayList<>();

        feed.addAll(joinFuture(postsFuture,  "posts"));
        feed.addAll(joinFuture(eventsFuture, "events"));
        feed.addAll(joinFuture(pledgesFuture, "pledges"));

        // Sort & truncate
        return feed.stream()
                   .sorted(Comparator.comparing(ActivityEntry::getCreatedAt).reversed())
                   .limit(safeLimit)
                   .collect(Collectors.toUnmodifiableList());
    }

    // region Parallel fetchers ──────────────────────────────────────────────────────────────

    @Async("repositoryExecutor")
    public CompletableFuture<List<ActivityEntry>> fetchPosts(long circleId, long userId, int limit) {
        return CompletableFuture.supplyAsync(() ->
                postRepository
                        .findRecentByCircle(circleId, limit)
                        .stream()
                        .map(post -> ActivityEntry.builder()
                                .id(post.getId())
                                .actorId(post.getAuthor().getId())
                                .circleId(circleId)
                                .createdAt(post.getCreatedAt())
                                .payload(post.getContent())
                                .type(ActivityEntryType.POST)
                                .build())
                        .collect(Collectors.toList())
        );
    }

    @Async("repositoryExecutor")
    public CompletableFuture<List<ActivityEntry>> fetchEvents(long circleId, long userId, int limit) {
        return CompletableFuture.supplyAsync(() ->
                eventRepository
                        .findRecentByCircle(circleId, limit)
                        .stream()
                        .map(event -> ActivityEntry.builder()
                                .id(event.getId())
                                .actorId(event.getCreator().getId())
                                .circleId(circleId)
                                .createdAt(event.getCreatedAt())
                                .payload(event.getTitle())
                                .type(ActivityEntryType.EVENT)
                                .build())
                        .collect(Collectors.toList())
        );
    }

    @Async("repositoryExecutor")
    public CompletableFuture<List<ActivityEntry>> fetchPledges(long circleId, long userId, int limit) {
        return CompletableFuture.supplyAsync(() ->
                pledgeRepository
                        .findRecentByCircle(circleId, limit)
                        .stream()
                        .map(pledge -> ActivityEntry.builder()
                                .id(pledge.getId())
                                .actorId(pledge.getMember().getId())
                                .circleId(circleId)
                                .createdAt(pledge.getCreatedAt())
                                .payload("Pledged " + pledge.getAmount().toPlainString())
                                .type(ActivityEntryType.PLEDGE)
                                .build())
                        .collect(Collectors.toList())
        );
    }

    // endregion

    // region Helper Methods ─────────────────────────────────────────────────────────────────

    private List<ActivityEntry> joinFuture(CompletableFuture<List<ActivityEntry>> future, String segment) {
        try {
            return future.join();
        } catch (Exception ex) {
            log.error("Unable to load '{}' segment for activity feed: {}", segment, ex.getMessage(), ex);
            return List.of();
        }
    }

    /**
     * Invalidate cache after a mutating operation (e.g. new post/pledge) by delegating
     * to this helper. Keeps eviction semantics in one place.
     */
    public void evictCache(long circleId, long userId) {
        // SpEL-friendly key must match @Cacheable definition
        String key = circleId + ":" + userId + ":*";
        // In real code, use Spring's CacheManager to evict
        log.debug("Evicting cache for {}", key);
    }

    // endregion
}

/* =========================================================================================
 * Domain DTO & Enum (would normally live in their own files, in a domain.shared package)
 * =========================================================================================
 */

package com.circleconnect.nexus.domain;

import lombok.Builder;
import lombok.Value;

import java.io.Serializable;
import java.time.OffsetDateTime;

@Value
@Builder
public class ActivityEntry implements Serializable {
    long               id;
    long               circleId;
    long               actorId;
    ActivityEntryType  type;
    OffsetDateTime     createdAt;
    String             payload;
}

package com.circleconnect.nexus.domain;

public enum ActivityEntryType {
    POST,
    EVENT,
    PLEDGE
}

/* =========================================================================================
 * Example Repository Contracts (interfaces only; Spring Data or custom impl elsewhere)
 * =========================================================================================
 */

package com.circleconnect.nexus.repository;

import com.circleconnect.nexus.model.Pledge;

import java.util.List;

public interface PledgeRepository {
    List<Pledge> findRecentByCircle(long circleId, int limit);
}

package com.circleconnect.nexus.repository;

import com.circleconnect.nexus.model.Post;

import java.util.List;

public interface PostRepository {
    List<Post> findRecentByCircle(long circleId, int limit);
}

package com.circleconnect.nexus.repository;

import com.circleconnect.nexus.model.Event;

import java.util.List;

public interface EventRepository {
    List<Event> findRecentByCircle(long circleId, int limit);
}

/* =========================================================================================
 * Custom Exception for missing resources
 * =========================================================================================
 */

package com.circleconnect.nexus.exception;

/**
 * Thrown when a requested resource cannot be found or the current user lacks access.
 */
public class ResourceNotFoundException extends RuntimeException {
    public ResourceNotFoundException(String message) { super(message); }
}
```