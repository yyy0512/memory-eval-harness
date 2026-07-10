```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers;

use DateTimeImmutable;
use Psr\Log\LoggerInterface;
use Psr\SimpleCache\CacheInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\EventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\HandlerInterface;

/**
 * Class ThrottlingHandler
 *
 * A Chain-of-Responsibility handler that rate-limits repetitive events
 * to avoid alert-storms and downstream saturation.
 *
 * Implementation notes
 * --------------------
 * • A lightweight token-bucket strategy is used, backed by a PSR-16 cache.
 * • Per-event “fingerprint” (source + type + subjectId) is the key.
 * • A sliding window is emulated by persisting a counter and the timestamp
 *   of the first message within the current window.
 * • No external state is leaked; the class is therefore process-safe.
 *
 * This handler is intentionally agnostic of the concrete cache implementation
 * so that the DI container can wire Redis, APCu, Memcached, etc.
 */
final class ThrottlingHandler implements HandlerInterface
{
    private const DEFAULT_WINDOW_SECONDS = 60;  // 1 minute sliding-window
    private const DEFAULT_BURST_LIMIT    = 10;  // max 10 msgs / window

    private CacheInterface   $cache;
    private LoggerInterface  $logger;
    private int              $windowSize;
    private int              $burstLimit;

    /** @var HandlerInterface|null */
    private ?HandlerInterface $next;

    /**
     * ThrottlingHandler constructor.
     *
     * @param CacheInterface        $cache       PSR-16 cache
     * @param LoggerInterface       $logger      PSR-3 compliant logger
     * @param int|null              $windowSize  Sliding window (sec)
     * @param int|null              $burstLimit  Token budget / window
     * @param HandlerInterface|null $next        Next handler in the chain
     */
    public function __construct(
        CacheInterface $cache,
        LoggerInterface $logger,
        ?int $windowSize = null,
        ?int $burstLimit = null,
        ?HandlerInterface $next = null
    ) {
        $this->cache      = $cache;
        $this->logger     = $logger;
        $this->windowSize = $windowSize ?? self::DEFAULT_WINDOW_SECONDS;
        $this->burstLimit = $burstLimit ?? self::DEFAULT_BURST_LIMIT;
        $this->next       = $next;
    }

    /**
     * {@inheritdoc}
     */
    public function handle(EventInterface $event): void
    {
        try {
            $fingerprint = $this->fingerprint($event);

            if ($this->isThrottled($fingerprint)) {
                $this->logger->warning(
                    'Event throttled to avoid alert storm.',
                    [
                        'fingerprint' => $fingerprint,
                        'type'        => $event->getType(),
                        'source'      => $event->getSource(),
                    ]
                );

                // Short-circuit the chain: swallow the noisy event.
                return;
            }

            // Forward to next handler if present.
            if ($this->next instanceof HandlerInterface) {
                $this->next->handle($event);
            }
        } catch (\Throwable $e) {
            // Do not bring down the pipeline — just log and continue.
            $this->logger->error('ThrottlingHandler failed: '.$e->getMessage(), [
                'exception' => $e,
            ]);
        }
    }

    /**
     * Attach a follow-up handler at runtime.
     *
     * @param HandlerInterface $next
     * @return void
     */
    public function setNext(HandlerInterface $next): void
    {
        $this->next = $next;
    }

    /**
     * Build a reproducible, collision-resistant fingerprint for the event.
     *
     * @param EventInterface $event
     * @return string
     */
    private function fingerprint(EventInterface $event): string
    {
        return hash('sha256', sprintf(
            '%s|%s|%s',
            $event->getSource(),
            $event->getType(),
            $event->getSubjectId() ?? ''
        ));
    }

    /**
     * Evaluate whether the given fingerprint is over quota and
     * update sliding-window counters accordingly.
     *
     * @param string $fingerprint
     * @return bool true if event must be throttled
     */
    private function isThrottled(string $fingerprint): bool
    {
        $now  = time();
        $data = $this->cache->get($fingerprint);

        // Initialize or refresh sliding-window structure
        if (!is_array($data) || !isset($data['count'], $data['createdAt'])) {
            $data = [
                'count'     => 0,
                'createdAt' => $now,
            ];
        }

        // Reset bucket if window has passed
        if (($now - $data['createdAt']) >= $this->windowSize) {
            $data['count']     = 0;
            $data['createdAt'] = $now;
        }

        // Consume one token
        $data['count']++;

        // Persist updated bucket with TTL equal to remaining window
        $ttl = $this->windowSize - ($now - $data['createdAt']);
        $this->cache->set($fingerprint, $data, $ttl);

        return $data['count'] > $this->burstLimit;
    }
}
```