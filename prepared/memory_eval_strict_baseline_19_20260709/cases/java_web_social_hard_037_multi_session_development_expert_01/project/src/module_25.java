```java
package com.circleconnect.nexus.module25;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.Assert;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.Serial;
import java.io.Serializable;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/**
 * Production-grade module responsible for periodically recalculating
 * the “influence score” of every circle member based on engagement
 * metrics (posts, comments, votes, pledges, etc.).
 *
 * Although a single file, the module follows the same layered design
 * used throughout CircleConnect Nexus:
 *
 *   • JPA entities + repositories
 *   • Service layer with transactional boundaries
 *   • RESTful admin controller
 *   • Scheduler for automatic recalculations
 *
 * NOTE:
 *   In a full-blown codebase these classes would live in their own
 *   files.  They are co-located here only to satisfy the constraints
 *   of this coding exercise (single-file output).
 */
@EnableScheduling
@Configuration
public class Module25 implements InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(Module25.class);

    // ---------------------------------------------------------------------
    // Configuration (weight tuning)
    // ---------------------------------------------------------------------

    @Value("${circle.influence.weights.post:2.5}")
    private BigDecimal postWeight;

    @Value("${circle.influence.weights.comment:1.5}")
    private BigDecimal commentWeight;

    @Value("${circle.influence.weights.vote:0.5}")
    private BigDecimal voteWeight;

    @Value("${circle.influence.weights.pledge:3.0}")
    private BigDecimal pledgeWeight;

    @Override
    public void afterPropertiesSet() {
        log.info("Influence weight configuration – post: {}, comment: {}, vote: {}, pledge: {}",
                postWeight, commentWeight, voteWeight, pledgeWeight);
    }

    // ---------------------------------------------------------------------
    // Scheduler
    // ---------------------------------------------------------------------

    /**
     * Periodically trigger influence score recalculation of all circles.
     * Cron expression defaults to every 10 min but can be overridden in
     * application-*.yml.
     */
    @Scheduled(cron = "${circle.influence.cron:0 */10 * * * *}")
    public void scheduledRecalculation(InfluenceScoreService service) {
        log.debug("Starting scheduled influence-score recalculation …");
        service.recalculateAllCirclesAsync()
               .exceptionally(throwable -> {
                   log.error("Scheduled influence calculation failed!", throwable);
                   return null;
               });
    }

    // ---------------------------------------------------------------------
    // Domain entities and repositories
    // ---------------------------------------------------------------------

    /**
     * Embedded id representing a unique member inside a circle.
     */
    @Embeddable
    public record CircleMemberId(UUID circleId, UUID userId) implements Serializable {
        @Serial private static final long serialVersionUID = 42L;
    }

    @Entity
    @Table(name = "circle_members",
           indexes = {
               @Index(name = "idx_member_circle", columnList = "circle_id"),
               @Index(name = "idx_member_user", columnList = "user_id")
           })
    public static class CircleMember {

        @EmbeddedId
        private CircleMemberId id;

        @Column(name = "influence_score", nullable = false)
        private BigDecimal influenceScore = BigDecimal.ZERO;

        @Column(name = "last_calculated_at", nullable = false)
        private Instant lastCalculatedAt = Instant.EPOCH;

        protected CircleMember() { /* JPA */ }

        public CircleMember(CircleMemberId id) {
            this.id = Objects.requireNonNull(id);
        }

        public CircleMemberId getId() { return id; }

        public BigDecimal getInfluenceScore() { return influenceScore; }

        public void setInfluenceScore(BigDecimal influenceScore) {
            this.influenceScore = influenceScore;
        }

        public Instant getLastCalculatedAt() { return lastCalculatedAt; }

        public void setLastCalculatedAt(Instant lastCalculatedAt) {
            this.lastCalculatedAt = lastCalculatedAt;
        }
    }

    public interface CircleMemberRepository extends JpaRepository<CircleMember, CircleMemberId> {
        List<CircleMember> findByIdCircleId(UUID circleId);
    }

    // ---------------------------------------------------------------------
    // Service layer
    // ---------------------------------------------------------------------

    @Validated
    @Transactional(readOnly = true)
    public static class InfluenceScoreService {

        private static final Logger log = LoggerFactory.getLogger(InfluenceScoreService.class);

        private final CircleMemberRepository memberRepository;
        private final EngagementSnapshotRepository snapshotRepository;
        private final Module25 config;

        public InfluenceScoreService(CircleMemberRepository memberRepository,
                                     EngagementSnapshotRepository snapshotRepository,
                                     Module25 config) {
            this.memberRepository = memberRepository;
            this.snapshotRepository = snapshotRepository;
            this.config = config;
        }

        /**
         * Recalculate influence scores for every member in the given circle.
         */
        @Transactional
        public int recalculateScoresForCircle(UUID circleId) {
            Assert.notNull(circleId, "circleId must not be null");

            List<EngagementSnapshot> snapshots = snapshotRepository.findByCircleId(circleId);
            Map<CircleMemberId, BigDecimal> scores = calculateWeights(snapshots);

            List<CircleMember> members = memberRepository.findByIdCircleId(circleId);
            members.forEach(member -> {
                BigDecimal newScore = scores.getOrDefault(member.getId(), BigDecimal.ZERO);
                member.setInfluenceScore(newScore);
                member.setLastCalculatedAt(Instant.now());
            });

            memberRepository.saveAll(members);
            log.info("Recalculated influence scores for circle={} ({} members)", circleId, members.size());
            return members.size();
        }

        /**
         * Launch asynchronous recalculation of every registered circle.
         */
        public CompletableFuture<Void> recalculateAllCirclesAsync() {
            return CompletableFuture.runAsync(() -> {
                Set<UUID> circleIds = snapshotRepository.findDistinctCircleIds();
                for (UUID circleId : circleIds) {
                    try {
                        recalculateScoresForCircle(circleId);
                    } catch (Exception ex) {
                        // Continue with other circles but log the error
                        log.error("Failed to recalculate circle={} influence score", circleId, ex);
                    }
                }
            });
        }

        /**
         * Helper performing the weighted influence calculation.
         */
        private Map<CircleMemberId, BigDecimal> calculateWeights(List<EngagementSnapshot> snapshots) {
            Map<CircleMemberId, BigDecimal> weighted = new HashMap<>();
            for (EngagementSnapshot snap : snapshots) {
                weighted.merge(snap.memberId(),
                               snap.weight(config),
                               BigDecimal::add);
            }
            return weighted;
        }
    }

    // ---------------------------------------------------------------------
    // Engagement snapshots (read-only analytics data)
    // ---------------------------------------------------------------------

    @Entity
    @Table(name = "engagement_snapshot_view")
    public static class EngagementSnapshot {

        @EmbeddedId
        private CircleMemberId memberId;

        @Column(name = "posts")
        @Min(0)
        private int posts;

        @Column(name = "comments")
        @Min(0)
        private int comments;

        @Column(name = "votes")
        @Min(0)
        private int votes;

        @Column(name = "pledges")
        @Min(0)
        private int pledges;

        protected EngagementSnapshot() { /* JPA view */ }

        public CircleMemberId memberId() { return memberId; }

        public BigDecimal weight(Module25 cfg) {
            return cfg.postWeight.multiply(BigDecimal.valueOf(posts))
                    .add(cfg.commentWeight.multiply(BigDecimal.valueOf(comments)))
                    .add(cfg.voteWeight.multiply(BigDecimal.valueOf(votes)))
                    .add(cfg.pledgeWeight.multiply(BigDecimal.valueOf(pledges)));
        }
    }

    public interface EngagementSnapshotRepository {

        /**
         * Query implementation uses a database VIEW; no write operations.
         */
        List<EngagementSnapshot> findByCircleId(UUID circleId);

        Set<UUID> findDistinctCircleIds();
    }

    // ---------------------------------------------------------------------
    // REST Controller (Admin)
    // ---------------------------------------------------------------------

    @RestController
    @RequestMapping("/api/admin/influence")
    public static class InfluenceAdminController {

        private final InfluenceScoreService service;

        public InfluenceAdminController(InfluenceScoreService service) {
            this.service = service;
        }

        /**
         * Trigger manual influence-score recalculation of a single circle.
         */
        @PostMapping("/{circleId}/recalculate")
        @ResponseStatus(HttpStatus.ACCEPTED)
        public Map<String, Object> manualRecalculate(@PathVariable UUID circleId) {
            try {
                int affectedMembers = service.recalculateScoresForCircle(circleId);
                return Map.of(
                    "circleId", circleId,
                    "affectedMembers", affectedMembers,
                    "status", "RUNNING"
                );
            } catch (DataAccessException e) {
                throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "Database error while recalculating influence score", e
                );
            }
        }

        /**
         * Recalculate influence scores of ALL circles (expensive).
         * Executed asynchronously.
         */
        @PostMapping("/recalculateAll")
        @ResponseStatus(HttpStatus.ACCEPTED)
        public Map<String, String> manualRecalculateAll() {
            service.recalculateAllCirclesAsync();
            return Map.of("status", "RUNNING");
        }
    }

    // ---------------------------------------------------------------------
    // DTOs (for potential future use)
    // ---------------------------------------------------------------------

    public record InfluenceScoreDTO(
        UUID circleId,
        UUID userId,
        BigDecimal influenceScore,
        Instant updatedAt
    ) implements Serializable {
        @Serial private static final long serialVersionUID = 1L;

        @JsonCreator
        public InfluenceScoreDTO(
                @JsonProperty("circleId") UUID circleId,
                @JsonProperty("userId") UUID userId,
                @JsonProperty("influenceScore") BigDecimal influenceScore,
                @JsonProperty("updatedAt") Instant updatedAt) {
            this.circleId = circleId;
            this.userId = userId;
            this.influenceScore = influenceScore;
            this.updatedAt = updatedAt;
        }
    }
}
```