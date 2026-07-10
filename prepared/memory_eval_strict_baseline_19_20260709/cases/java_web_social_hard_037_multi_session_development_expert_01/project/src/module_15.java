package com.circleconnect.nexus.module15;

import com.circleconnect.nexus.domain.activity.CircleActivityEvent;
import com.circleconnect.nexus.domain.activity.PledgeActivityEvent;
import com.circleconnect.nexus.domain.circle.Circle;
import com.circleconnect.nexus.domain.circle.CircleNotFoundException;
import com.circleconnect.nexus.domain.user.User;
import com.circleconnect.nexus.domain.user.UserNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.CachePut;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DataAccessException;
import org.springframework.lang.NonNull;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.*;
import java.io.Serial;
import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * InfluenceScoreService keeps the running "influence" number for every
 * (user, circle) pair, a value that directly affects a member’s visibility,
 * voting weight, and moderation privileges. <p>
 *
 * Business rules (abridged):
 *  - Upvotes garnered on posts           -> +2 points
 *  - Comments made                       -> +1 point
 *  - Pledges successfully paid           -> +5 points
 *  - Published events participation      -> +3 points
 *  - Oldest 90-day contributions fade by 30 % (decay)
 *
 * Scores are recalculated incrementally whenever a domain event occurs and
 * re-synchronized with the persistent store on a nightly sweep to guarantee
 * eventual consistency. All heavy reads are cached.
 */
@Service
public class InfluenceScoreService {

    private static final Logger log = LoggerFactory.getLogger(InfluenceScoreService.class);

    private final InfluenceScoreRepository scoreRepo;
    private final ActivitySnapshotRepository snapshotRepo;
    private final CircleRepository circleRepo;
    private final UserRepository userRepo;
    private final CacheManager cacheManager;

    /**
     * Guards recalculation per (user,circle) to prevent thundering-herd when
     * bursts of events arrive in parallel.
     */
    private final ConcurrentHashMap<String, Lock> calculationGuards = new ConcurrentHashMap<>();

    public InfluenceScoreService(
            InfluenceScoreRepository scoreRepo,
            ActivitySnapshotRepository snapshotRepo,
            CircleRepository circleRepo,
            UserRepository userRepo,
            CacheManager cacheManager
    ) {
        this.scoreRepo    = scoreRepo;
        this.snapshotRepo = snapshotRepo;
        this.circleRepo   = circleRepo;
        this.userRepo     = userRepo;
        this.cacheManager = cacheManager;
    }

    /* =========================================================================
       Public API
       ========================================================================= */

    @Cacheable(cacheNames = "influenceScores", key = "T(String).format('%s:%s', #userId, #circleId)")
    public double getCurrentScore(@NonNull UUID userId, @NonNull UUID circleId) {
        return scoreRepo.findByUserIdAndCircleId(userId, circleId)
                        .map(InfluenceScore::getScore)
                        .orElseGet(() -> {
                            log.debug("Influence score cache miss for user {} in circle {}", userId, circleId);
                            return recalculate(userId, circleId).getScore();
                        });
    }

    /**
     * Forces a synchronous recalculation. Cache is updated atomically.
     */
    @Transactional
    @CachePut(cacheNames = "influenceScores", key = "T(String).format('%s:%s', #userId, #circleId)")
    public double forceRecalculateAndGet(@NonNull UUID userId, @NonNull UUID circleId) {
        return recalculate(userId, circleId).getScore();
    }

    /* =========================================================================
       Domain-Event listeners
       ========================================================================= */

    @EventListener({CircleActivityEvent.class, PledgeActivityEvent.class})
    public void handleActivityEvents(Object evt) {
        UUID userId;
        UUID circleId;

        if (evt instanceof CircleActivityEvent) {
            CircleActivityEvent e = (CircleActivityEvent) evt;
            userId   = e.userId();
            circleId = e.circleId();
        } else if (evt instanceof PledgeActivityEvent) {
            PledgeActivityEvent e = (PledgeActivityEvent) evt;
            userId   = e.userId();
            circleId = e.circleId();
        } else {
            // Unknown event → ignore
            return;
        }

        try {
            forceRecalculateAndGet(userId, circleId);
        } catch (Exception ex) {
            log.warn("Unable to recalculate influence for user {} in circle {} caused by {}",
                     userId, circleId, ex.getMessage());
        }
    }

    /* =========================================================================
       Scheduled maintenance
       ========================================================================= */

    /**
     * Nightly job makes sure every persisted score is up-to-date. Runs at 03:15.
     */
    @Scheduled(cron = "0 15 3 * * *")
    @Transactional
    @CacheEvict(cacheNames = "influenceScores", allEntries = true)
    public void nightlySweep() {
        log.info("Starting nightly influence score sweep …");
        for (InfluenceScore s : scoreRepo.findAll()) {
            try {
                recalculate(s.getUserId(), s.getCircleId());
            } catch (Exception ex) {
                log.error("Failed to recalculate score for user {} in circle {}: {}",
                          s.getUserId(), s.getCircleId(), ex.getMessage(), ex);
            }
        }
        log.info("Nightly influence score sweep completed.");
    }

    /* =========================================================================
       Internal calculation logic
       ========================================================================= */

    @Transactional
    protected InfluenceScore recalculate(UUID userId, UUID circleId) {
        Objects.requireNonNull(userId);
        Objects.requireNonNull(circleId);

        // Basic entity sanity checks
        Circle circle = circleRepo.findById(circleId)
                                  .orElseThrow(() -> new CircleNotFoundException(circleId));
        User user     = userRepo.findById(userId)
                                .orElseThrow(() -> new UserNotFoundException(userId));

        String guardKey = userId + ":" + circleId;
        Lock   lock     = calculationGuards.computeIfAbsent(guardKey, k -> new ReentrantLock());

        lock.lock();
        try {
            ActivitySnapshot snapshot = snapshotRepo.getSnapshot(circleId, userId);

            // Influence formula (simple weighted sum + decay)
            double score =
                    snapshot.upvotes()             * 2.0
                  + snapshot.comments()           * 1.0
                  + snapshot.successfulPledges()  * 5.0
                  + snapshot.eventParticipations() * 3.0;

            score *= decayFactor(snapshot.latestActivity());

            InfluenceScore entity = scoreRepo.findByUserIdAndCircleId(userId, circleId)
                                             .orElse(new InfluenceScore(userId, circleId));

            entity.setScore(score);
            entity.setUpdatedAt(Instant.now());

            // Persist and return
            return scoreRepo.save(entity);

        } catch (DataAccessException dae) {
            log.error("Database error while recalculating influence for user {} in circle {}",
                      userId, circleId, dae);
            throw dae; // transaction will roll back
        } finally {
            lock.unlock();
        }
    }

    /**
     * Returns a multiplicative decay in the range (0,1].
     * Fresh activity (within 30 days) -> 1.0
     * 30–90 days                      -> linearly drops to 0.70
     * Older                            -> minimum 0.50
     */
    private double decayFactor(Instant latestActivity) {
        long days = (Instant.now().toEpochMilli() - latestActivity.toEpochMilli()) / 86_400_000;

        if (days <= 30) return 1.0;
        if (days <= 90) return 1.0 - ((days - 30) * 0.005); // drops from 1.0 .. 0.70
        return 0.50;
    }
}

/* =========================================================================
   JPA Model + Repository
   ========================================================================= */

@Entity
@Table(name = "influence_scores", uniqueConstraints = {
        @UniqueConstraint(columnNames = {"user_id", "circle_id"})
})
class InfluenceScore implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    private UUID userId;

    @Column(name = "circle_id", nullable = false, columnDefinition = "uuid")
    private UUID circleId;

    @Column(nullable = false)
    private double score;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    /* JPA constructor */
    protected InfluenceScore() {}

    InfluenceScore(UUID userId, UUID circleId) {
        this.userId = userId;
        this.circleId = circleId;
        this.score = 0.0;
    }

    // Getters & Setters
    public UUID getId()            { return id;       }
    public UUID getUserId()        { return userId;   }
    public UUID getCircleId()      { return circleId; }
    public double getScore()       { return score;    }
    public Instant getUpdatedAt()  { return updatedAt;}

    public void setScore(double score) {
        this.score = score;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }
}

interface InfluenceScoreRepository extends org.springframework.data.jpa.repository.JpaRepository<InfluenceScore, UUID> {
    Optional<InfluenceScore> findByUserIdAndCircleId(UUID userId, UUID circleId);
}

/* =========================================================================
   Domain-specific data providers (projections only)
   ========================================================================= */

interface ActivitySnapshotRepository {
    /**
     * Returns a lightweight projection of user activity inside a circle.
     */
    ActivitySnapshot getSnapshot(UUID circleId, UUID userId);
}

record ActivitySnapshot(
        int upvotes,
        int comments,
        int successfulPledges,
        int eventParticipations,
        Instant latestActivity
) {}

interface CircleRepository {
    Optional<Circle> findById(UUID id);
}

interface UserRepository {
    Optional<User> findById(UUID id);
}

/* =========================================================================
   Placeholder domain types so the file compiles in isolation
   ========================================================================= */
class Circle {
    // domain fields left out
}

class User {
    // domain fields left out
}

class CircleNotFoundException extends RuntimeException {
    CircleNotFoundException(UUID id) { super("Circle '" + id + "' not found"); }
}

class UserNotFoundException extends RuntimeException {
    UserNotFoundException(UUID id) { super("User '" + id + "' not found"); }
}