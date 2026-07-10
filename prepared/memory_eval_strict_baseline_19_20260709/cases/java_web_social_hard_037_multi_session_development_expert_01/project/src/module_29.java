package com.circleconnect.nexus.domain.influence;

import com.circleconnect.nexus.common.events.InfluenceScoreUpdatedEvent;
import com.circleconnect.nexus.common.exceptions.BusinessRuleViolationException;
import com.circleconnect.nexus.common.metrics.MetricNames;
import com.circleconnect.nexus.domain.activity.ActivityWeightProvider;
import com.circleconnect.nexus.domain.circle.Circle;
import com.circleconnect.nexus.domain.circle.CircleRepository;
import com.circleconnect.nexus.domain.post.PostRepository;
import com.circleconnect.nexus.domain.user.User;
import com.circleconnect.nexus.domain.user.UserRepository;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.Nullable;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import lombok.AccessLevel;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Module 29 – Influence score evaluator
 *
 * <p>Computes, persists, and publishes the social “influence score” of users inside CircleConnect
 * Nexus. The score is an aggregate of multiple interaction factors—posts, comments, received votes,
 * pledge participation, and circle ownership—each weighted by {@link ActivityWeightProvider}.
 *
 * <p>Design highlights:
 * <ul>
 *   <li>Read-through caching (Spring Cache abstraction) to reduce DB pressure on frequently queried
 *   scores.</li>
 *   <li>Cron-like recalculation—hourly delta updates + nightly full rebuild—to keep scores fresh
 *   but computationally bounded.</li>
 *   <li>Domain event emission ({@link InfluenceScoreUpdatedEvent}) decouples score changes from
 *   consumers (feed ranking, badge attribution, etc.).</li>
 *   <li>Metrics via Micrometer for ops visibility.</li>
 * </ul>
 *
 * <p><b>Thread-safety:</b> Uses Spring’s transactional semantics; expensive ops off-loaded to an
 * async executor when triggered synchronously.</p>
 */
@Service
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
@Slf4j
public class Module29 implements InfluenceScoreService {

    UserRepository userRepository;
    PostRepository postRepository;
    CircleRepository circleRepository;
    InfluenceScoreRepository influenceScoreRepository;
    ActivityWeightProvider weightProvider;
    ApplicationEventPublisher eventPublisher;
    MeterRegistry meterRegistry;

    /* -----------------------------  PUBLIC API  ----------------------------- */

    /**
     * Returns the current cached influence score for a user (rounded to two decimals).
     */
    @Override
    @Cacheable(cacheNames = "userInfluence", key = "#userId")
    public BigDecimal getCurrentScore(@NonNull UUID userId) {
        return influenceScoreRepository.findById(userId)
              .map(InfluenceScoreEntity::getScore)
              .orElse(BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP));
    }

    /**
     * Re-computes the influence score of a single user and publishes an update event.
     *
     * <p>Unless called inside a batch context, the method is executed asynchronously.</p>
     *
     * @throws BusinessRuleViolationException if user does not exist.
     */
    @Override
    @Async("influenceExecutor")
    @CacheEvict(cacheNames = "userInfluence", key = "#userId")
    @Transactional
    public void recalculateInfluenceForUser(@NonNull UUID userId) {
        User user = userRepository.findById(userId)
              .orElseThrow(() -> new BusinessRuleViolationException("User not found"));

        BigDecimal score = performScoreComputation(user);

        InfluenceScoreEntity entity =
              influenceScoreRepository.findById(userId)
                    .orElseGet(() -> new InfluenceScoreEntity(userId, BigDecimal.ZERO));

        BigDecimal previous = entity.getScore();
        entity.setScore(score);
        influenceScoreRepository.save(entity);

        publishEventIfChanged(userId, previous, score);

        meterRegistry.counter(MetricNames.INFLUENCE_RECALCULATION_TOTAL).increment();
    }

    /* --------------------------  SCHEDULED JOBS  --------------------------- */

    /**
     * Lightweight hourly job—only scores touched in the last hour are updated.
     * Reduces write-amplification during peak usage windows.
     */
    @Scheduled(cron = "0 15 * * * *", zone = "UTC")
    public void recalculateHourlyDeltas() {
        Instant since = Instant.now().minus(1, ChronoUnit.HOURS);
        Stream<UUID> candidates = Stream.of(
              postRepository.findDistinctAuthorIdsSince(since),
              circleRepository.findDistinctMemberIdsSince(since));

        AtomicInteger processed = new AtomicInteger();
        candidates.flatMap(List::stream)
                  .distinct()
                  .forEach(id -> {
                      try {
                          recalculateInfluenceForUser(id);
                          processed.incrementAndGet();
                      } catch (Exception ex) {
                          log.error("Failed to recalculate influence for user={}", id, ex);
                          meterRegistry.counter(MetricNames.INFLUENCE_RECALCULATION_FAILURE).increment();
                      }
                  });

        log.info("Hourly influence recalculation completed – {} users processed", processed.get());
    }

    /**
     * Full rebuild executed during maintenance window (03:30 UTC).
     */
    @Scheduled(cron = "0 30 3 * * *", zone = "UTC")
    public void nightlyRebuild() {
        List<UUID> allUserIds = userRepository.fetchAllUserIds();
        log.info("Nightly influence rebuild started – {} users", allUserIds.size());

        for (UUID id : allUserIds) {
            try {
                recalculateInfluenceForUser(id);
            } catch (Exception ex) {
                log.error("Nightly rebuild failed for user={}", id, ex);
            }
        }
        log.info("Nightly influence rebuild finished");
    }

    /* ------------------------------  HELPERS  ------------------------------ */

    @Transactional(readOnly = true)
    protected BigDecimal performScoreComputation(@NotNull User user) {
        try {
            long recentPosts = postRepository.countByAuthorIdAndCreatedAfter(
                  user.getId(), Instant.now().minus(30, ChronoUnit.DAYS));

            long upVotes = postRepository.countUpvotesReceived(user.getId());
            long circlesOwned = circleRepository.countByOwnerId(user.getId());
            long circlesJoined = circleRepository.countMemberships(user.getId());

            double rawScore =
                  recentPosts * weightProvider.weightForPosts()
                        + upVotes * weightProvider.weightForReceivedVotes()
                        + circlesOwned * weightProvider.weightForCircleOwnership()
                        + circlesJoined * weightProvider.weightForCircleMembership();

            return BigDecimal.valueOf(rawScore)
                  .setScale(2, RoundingMode.HALF_UP);
        } catch (DataAccessException ex) {
            log.error("DB failure during influence calculation for user={}", user.getId(), ex);
            throw ex;
        }
    }

    private void publishEventIfChanged(UUID userId, BigDecimal previous, BigDecimal current) {
        if (previous.compareTo(current) != 0) {
            eventPublisher.publishEvent(
                  new InfluenceScoreUpdatedEvent(this, userId, previous, current));
            log.debug("Influence score updated for user={} [{} → {}]", userId, previous, current);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* -------------------------  INTERNAL INTERFACES  -------------------------- */
/* -------------------------------------------------------------------------- */

interface InfluenceScoreService {

    /**
     * Returns the current influence score. Cached for fast feed querying.
     */
    BigDecimal getCurrentScore(UUID userId);

    /**
     * Triggers a recalculation of the given user’s influence.
     */
    void recalculateInfluenceForUser(UUID userId);
}

/* -------------------------------------------------------------------------- */
/* ---------------------------  JPA INTEGRATION  ---------------------------- */
/* -------------------------------------------------------------------------- */

import java.math.BigDecimal;
import java.util.UUID;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Lightweight table: user_influence(id, score)
 */
@Entity
@Table(name = "user_influence")
@Data
@NoArgsConstructor
@AllArgsConstructor
class InfluenceScoreEntity {

    @Id
    UUID userId;

    @Column(nullable = false, precision = 16, scale = 2)
    BigDecimal score;
}

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

/**
 * Spring Data repository for {@link InfluenceScoreEntity}.
 */
interface InfluenceScoreRepository extends JpaRepository<InfluenceScoreEntity, UUID> {

    @Query("select e.userId from InfluenceScoreEntity e")
    List<UUID> findAllUserIds();
}