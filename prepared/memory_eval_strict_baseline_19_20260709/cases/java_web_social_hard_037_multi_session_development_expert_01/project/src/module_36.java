package com.circleconnect.nexus.module;

import com.circleconnect.nexus.common.events.CircleInfluenceRecalculatedEvent;
import com.circleconnect.nexus.domain.activity.Activity;
import com.circleconnect.nexus.domain.activity.ActivityType;
import com.circleconnect.nexus.domain.circle.Circle;
import com.circleconnect.nexus.domain.circle.InfluenceScore;
import com.circleconnect.nexus.repository.ActivityRepository;
import com.circleconnect.nexus.repository.CircleRepository;
import com.circleconnect.nexus.repository.InfluenceScoreRepository;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * Module 36 — circle influence scoring module.
 *
 * <p>Recalculates the influence scores for every circle based on recent activity. The computation
 * is executed at a fixed interval and automatically persists the new scores in a single
 * transactional batch to minimize I/O against the database. Upon successful recalculation an
 * application event is published so that other bounded contexts (feed ranking, discovery, etc.)
 * may react accordingly.</p>
 *
 * <p>Influence score formula (per circle, per window):
 *   1. POST_CREATED       weight = 5
 *   2. MEMBER_VOTE        weight = 3
 *   3. PLEDGE_COMPLETED   weight = 8
 *   4. EVENT_PUBLISHED    weight = 4
 *   5. MEMBER_JOINED      weight = 2
 *
 *   score = Σ(activityCount(type) * weight(type))
 * </p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CircleInfluenceScoringModule {

    // Re-scheduling period (15 minutes) –– tweakable via application.yml if needed
    private static final long CRON_MS = 1000 * 60 * 15;

    // Rolling window in hours to base the influence computation on.
    private static final int ROLLING_WINDOW_HOURS = 24;

    // Influence weight look-up table
    private static final Map<ActivityType, Integer> WEIGHTS;

    static {
        Map<ActivityType, Integer> tmp = new EnumMap<>(ActivityType.class);
        tmp.put(ActivityType.POST_CREATED,     5);
        tmp.put(ActivityType.MEMBER_VOTE,      3);
        tmp.put(ActivityType.PLEDGE_COMPLETED, 8);
        tmp.put(ActivityType.EVENT_PUBLISHED,  4);
        tmp.put(ActivityType.MEMBER_JOINED,    2);
        WEIGHTS = Collections.unmodifiableMap(tmp);
    }

    private final ActivityRepository activityRepository;
    private final CircleRepository circleRepository;
    private final InfluenceScoreRepository influenceScoreRepository;
    private final ApplicationEventPublisher eventPublisher;
    private final MeterRegistry meterRegistry;

    private AtomicLong lastRunSuccessful = new AtomicLong(0);

    @PostConstruct
    void registerMetrics() {
        meterRegistry.gauge("circle_influence_last_run_epoch", lastRunSuccessful);
    }

    /**
     * Scheduled job – will run every {@code CRON_MS} milliseconds.
     * Executes inside a single transaction so changes are atomically visible.
     */
    @Scheduled(fixedDelay = CRON_MS, initialDelay = CRON_MS)
    @Transactional
    public void recalculateInfluenceScores() {
        ZonedDateTime windowStart = ZonedDateTime.now(ZoneOffset.UTC).minusHours(ROLLING_WINDOW_HOURS);

        log.debug("Beginning influence score recalculation [windowStart={}]", windowStart);

        // Step 1 – Fetch raw activity slices for the window
        List<Activity> recentActivities = activityRepository.findAllAfter(windowStart.toInstant());
        if (recentActivities.isEmpty()) {
            log.info("No activities found for window – skipping influence calculation.");
            return;
        }

        // Step 2 – Partition by circle and tally
        Map<Long /*circleId*/, Map<ActivityType, Long /*count*/>> tally =
                recentActivities.stream()
                        .collect(Collectors.groupingBy(
                                Activity::getCircleId,
                                Collectors.groupingBy(
                                        Activity::getType,
                                        Collectors.counting()
                                )));

        // Step 3 – For each circle compute raw score
        List<InfluenceScore> newScores = tally.entrySet()
                .stream()
                .map(entry -> {
                    Long circleId = entry.getKey();
                    Map<ActivityType, Long> countsByType = entry.getValue();

                    long score = countsByType.entrySet()
                            .stream()
                            .mapToLong(e -> {
                                int weight = WEIGHTS.getOrDefault(e.getKey(), 1);
                                return e.getValue() * weight;
                            })
                            .sum();

                    return InfluenceScore.builder()
                            .circleId(circleId)
                            .score(score)
                            .computedAt(Instant.now())
                            .build();
                })
                .collect(Collectors.toList());

        // Step 4 – Persist new scores
        influenceScoreRepository.saveAll(newScores);

        // Step 5 – Mark timestamp for Prometheus metric
        lastRunSuccessful.set(Instant.now().getEpochSecond());

        // Step 6 – Publish domain event
        List<Long> circleIds = newScores.stream()
                .map(InfluenceScore::getCircleId)
                .collect(Collectors.toList());

        eventPublisher.publishEvent(new CircleInfluenceRecalculatedEvent(this, circleIds));

        log.info("Influence score recalculation completed – updated {} circles.", newScores.size());
    }
}