```java
package com.circleconnect.nexus.service.feed;

import com.circleconnect.nexus.domain.events.CircleEvent;
import com.circleconnect.nexus.domain.pledge.Pledge;
import com.circleconnect.nexus.domain.post.Post;
import com.circleconnect.nexus.domain.circle.Circle;
import com.circleconnect.nexus.domain.feed.FeedItem;
import com.circleconnect.nexus.repository.circle.CircleMembershipRepository;
import com.circleconnect.nexus.repository.event.CircleEventRepository;
import com.circleconnect.nexus.repository.pledge.PledgeRepository;
import com.circleconnect.nexus.repository.post.PostRepository;
import com.circleconnect.nexus.shared.logging.ActivityLogger;
import com.circleconnect.nexus.shared.security.PrincipalVerifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.lang.NonNull;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.stream.Collectors;

/**
 * Aggregates multi–source activity for a user’s personalised circle feed.
 *
 * <p>Data sources:</p>
 * <ul>
 *   <li>{@link Post} objects created in any of the user’s circles</li>
 *   <li>{@link CircleEvent} representing upcoming or updated events</li>
 *   <li>{@link Pledge} objects for crowd-funding campaigns</li>
 * </ul>
 *
 * <p>Combines items in reverse-chronological order, performs lightweight DTO mapping
 * and leverages second-level caching for heavily trafficked timelines.</p>
 *
 * <p>This service is a read-heavy, eventually consistent component. Cache eviction
 * is event-driven; each source entity publishes a domain event which is observed
 * in {@link #onSourceMutation(Object)} to invalidate stale feed pages.</p>
 */
@Service
public class CircleFeedAggregationService {

    private static final Logger LOG = LoggerFactory.getLogger(CircleFeedAggregationService.class);

    private final CircleMembershipRepository membershipRepository;
    private final PostRepository postRepository;
    private final CircleEventRepository eventRepository;
    private final PledgeRepository pledgeRepository;
    private final ApplicationEventPublisher eventPublisher;
    private final CacheManager cacheManager;
    private final Executor feedExecutor;
    private final PrincipalVerifier principalVerifier;
    private final ActivityLogger activityLogger;

    public CircleFeedAggregationService(
            CircleMembershipRepository membershipRepository,
            PostRepository postRepository,
            CircleEventRepository eventRepository,
            PledgeRepository pledgeRepository,
            ApplicationEventPublisher eventPublisher,
            CacheManager cacheManager,
            Executor feedExecutor,
            PrincipalVerifier principalVerifier,
            ActivityLogger activityLogger) {

        this.membershipRepository = membershipRepository;
        this.postRepository = postRepository;
        this.eventRepository = eventRepository;
        this.pledgeRepository = pledgeRepository;
        this.eventPublisher = eventPublisher;
        this.cacheManager = cacheManager;
        this.feedExecutor = feedExecutor;
        this.principalVerifier = principalVerifier;
        this.activityLogger = activityLogger;
    }

    /**
     * Returns a paginated, aggregated feed for the supplied user. Expensive calls are cached
     * on a per-page basis; cache is busted automatically whenever underlying entities mutate.
     *
     * @param userId    requesting user
     * @param pageable  Spring Data pagination descriptor
     * @return          ordered page of feed items
     */
    @Transactional(readOnly = true)
    @Cacheable(
            value = "circle-feed",
            key = "#userId.toString().concat('-p').concat(#pageable.pageNumber).concat('-s').concat(#pageable.pageSize)",
            unless = "#result == null || #result.isEmpty()")
    public Page<FeedItem> getFeedForUser(@NonNull UUID userId, @NonNull Pageable pageable) {

        principalVerifier.verify(userId); // defensive, ensures caller has permission

        try {
            List<UUID> circleIds = membershipRepository.findCircleIdsByUserId(userId);

            // Fan-out the queries in parallel to optimise latency
            CompletableFuture<List<FeedItem>> postFuture = CompletableFuture.supplyAsync(
                    () -> postRepository.findAllByCircleIdIn(circleIds, pageable.toOptional())
                                        .stream()
                                        .map(FeedItem::fromPost)
                                        .toList(),
                    feedExecutor);

            CompletableFuture<List<FeedItem>> eventFuture = CompletableFuture.supplyAsync(
                    () -> eventRepository.findAllByCircleIdIn(circleIds, pageable.toOptional())
                                         .stream()
                                         .map(FeedItem::fromCircleEvent)
                                         .toList(),
                    feedExecutor);

            CompletableFuture<List<FeedItem>> pledgeFuture = CompletableFuture.supplyAsync(
                    () -> pledgeRepository.findAllByCircleIdIn(circleIds, pageable.toOptional())
                                          .stream()
                                          .map(FeedItem::fromPledge)
                                          .toList(),
                    feedExecutor);

            List<FeedItem> combined = CompletableFuture.allOf(postFuture, eventFuture, pledgeFuture)
                                                       .thenApply(v -> {
                                                           List<FeedItem> items = new ArrayList<>();
                                                           items.addAll(postFuture.join());
                                                           items.addAll(eventFuture.join());
                                                           items.addAll(pledgeFuture.join());
                                                           return items;
                                                       })
                                                       .join();

            // Order descending by timestamp and slice according to pageable
            combined = combined.stream()
                               .sorted(Comparator.comparing(FeedItem::timestamp).reversed())
                               .collect(Collectors.toList());

            int total = combined.size();
            int from = Math.min(pageable.getPageNumber() * pageable.getPageSize(), total);
            int to = Math.min(from + pageable.getPageSize(), total);
            List<FeedItem> subList = from > to ? List.of() : combined.subList(from, to);

            // Audit the feed generation for monitoring purposes
            activityLogger.logFeedServed(userId, subList.size(), Instant.now());

            return new PageImpl<>(subList, pageable, total);

        } catch (DataAccessException ex) {
            LOG.error("Failed to get feed for user={}", userId, ex);
            // rethrow as unchecked to bubble through global handler
            throw new FeedUnavailableException("Unable to fetch feed at this time.", ex);
        }
    }

    /**
     * Listens for any mutation on the feed sources and triggers cache eviction.
     * The union of affected users is resolved lazily to avoid pigmentation of the meta-data.
     *
     * @param event domain event carrying the mutated source entity
     */
    @Async
    @EventListener
    @CacheEvict(value = "circle-feed", allEntries = true) // Fallback eviction
    public void onSourceMutation(Object event) {
        // Delegate to fine-grained eviction to avoid hammering the entire cache where possible
        try {
            List<UUID> affectedUsers = switch (event) {
                case Post post -> membershipRepository.findUserIdsByCircleId(post.getCircleId());
                case CircleEvent circleEvent -> membershipRepository.findUserIdsByCircleId(circleEvent.getCircleId());
                case Pledge pledge -> membershipRepository.findUserIdsByCircleId(pledge.getCircleId());
                default -> List.of();
            };

            for (UUID userId : affectedUsers) {
                cacheManager.getCache("circle-feed")
                            .invalidate() // sentinel to Spring 6 type-safe caches
                            .ifPresent(cache -> {
                                // enumerate pages lazily; this could be improved with heuristics
                                for (int page = 0; page < 10; page++) {         // up to first 10 pages
                                    String key = userId + "-p" + page + "-s20"; // assuming default page size = 20
                                    cache.evict(key);
                                }
                            });
            }
        } catch (Exception e) {
            LOG.warn("Source mutation listener failed; falling back to bulk eviction.", e);
        }
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * Custom runtime exception to decouple service layer from HTTP response layer.
     */
    public static class FeedUnavailableException extends RuntimeException {
        public FeedUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}

/* -----------------------------------------------------------------------------------------------
 * Domain-agnostic DTO (compact record). Convenient factory methods are defined in-record
 * to keep mapping code close to the data structure.
 * --------------------------------------------------------------------------------------------- */
package com.circleconnect.nexus.domain.feed;

import com.circleconnect.nexus.domain.events.CircleEvent;
import com.circleconnect.nexus.domain.pledge.Pledge;
import com.circleconnect.nexus.domain.post.Post;

import java.time.Instant;
import java.util.UUID;

/**
 * Canonical item for the CircleConnect aggregated feed.
 *
 * @param id         persistent entity id
 * @param circleId   circle which owns the entity
 * @param authorId   user who created the entity (or system id)
 * @param type       discriminated union of possible source types
 * @param title      human-readable headline
 * @param timestamp  chronological hint for ordering
 */
public record FeedItem(
        UUID id,
        UUID circleId,
        UUID authorId,
        Type type,
        String title,
        Instant timestamp) {

    public static FeedItem fromPost(Post post) {
        return new FeedItem(
                post.getId(),
                post.getCircleId(),
                post.getAuthorId(),
                Type.POST,
                post.getTitle(),
                post.getCreatedAt());
    }

    public static FeedItem fromCircleEvent(CircleEvent event) {
        String title = "Event • " + event.getName();
        return new FeedItem(
                event.getId(),
                event.getCircleId(),
                event.getOrganizerId(),
                Type.EVENT,
                title,
                event.getUpdatedAt() != null ? event.getUpdatedAt() : event.getCreatedAt());
    }

    public static FeedItem fromPledge(Pledge pledge) {
        String title = "Pledge • " + pledge.getGoalTitle();
        return new FeedItem(
                pledge.getId(),
                pledge.getCircleId(),
                pledge.getInitiatorId(),
                Type.PLEDGE,
                title,
                pledge.getCreatedAt());
    }

    public enum Type {
        POST,
        EVENT,
        PLEDGE
    }
}
```