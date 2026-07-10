```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Infrastructure\Notifier;

use DateTimeImmutable;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use ProdSecureOrchestrator\Domain\Notifier\Notification;
use ProdSecureOrchestrator\Domain\Notifier\NotifierInterface;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * SlackNotifier
 *
 * Sends notifications to a Slack workspace via an incoming-webhook URL.
 * Implements:
 *   – Automatic retry & exponential back-off for 429 responses
 *   – Context → attachment mapping
 *   – Severity → color mapping
 *   – PSR-3 logging
 *
 * @package ProdSecureOrchestrator\Infrastructure\Notifier
 */
final class SlackNotifier implements NotifierInterface
{
    private const MAX_RETRIES         = 5;
    private const BASE_BACKOFF_MS     = 500; // 0.5s
    private const CONTENT_TYPE_HEADER = 'application/json';

    private ClientInterface $httpClient;
    private LoggerInterface $logger;
    private string          $webhookUrl;
    private ?string         $defaultChannel;
    private string          $username;
    private string          $iconEmoji;

    public function __construct(
        ClientInterface $httpClient,
        LoggerInterface $logger,
        string          $webhookUrl,
        ?string         $defaultChannel = null,
        string          $username       = 'ProdSecure-Bot',
        string          $iconEmoji      = ':robot_face:'
    ) {
        $this->httpClient      = $httpClient;
        $this->logger          = $logger;
        $this->webhookUrl      = $webhookUrl;
        $this->defaultChannel  = $defaultChannel;
        $this->username        = $username;
        $this->iconEmoji       = $iconEmoji;
    }

    /**
     * {@inheritdoc}
     */
    public function notify(Notification $notification): void
    {
        $payload = $this->mapNotificationToPayload($notification);

        $attempt = 0;
        while ($attempt < self::MAX_RETRIES) {
            try {
                $response = $this->httpClient->request(
                    'POST',
                    $this->webhookUrl,
                    [
                        'headers' => ['Content-Type' => self::CONTENT_TYPE_HEADER],
                        'body'    => json_encode($payload, JSON_THROW_ON_ERROR),
                        'timeout' => 3.0,
                    ]
                );

                $status = $response->getStatusCode();

                // Success — Slack returns "200 OK" and literal "ok" in body.
                if ($status === 200) {
                    return;
                }

                // Slack rate-limiting
                if ($status === 429) {
                    $retryAfter = (int) $response->getHeaderLine('Retry-After');
                    $this->sleepWithBackoff($attempt, $retryAfter);
                    ++$attempt;
                    continue;
                }

                // Other non-retriable HTTP error
                $this->logger->error(
                    'Slack notifier received non-success HTTP response.',
                    ['status_code' => $status, 'body' => (string) $response->getBody()]
                );
                return;
            } catch (GuzzleException $e) {
                ++$attempt;
                $this->logger->warning(
                    'Slack notifier network/transport exception.',
                    ['attempt' => $attempt, 'message' => $e->getMessage()]
                );
                $this->sleepWithBackoff($attempt);
            } catch (Throwable $e) {
                // Do not propagate unexpected exceptions to calling code
                $this->logger->critical(
                    'Unhandled exception inside SlackNotifier.',
                    ['exception' => $e, 'payload' => $payload]
                );
                return;
            }
        }

        $this->logger->error(
            'Slack notifier exceeded maximum retry attempts.',
            ['retries' => self::MAX_RETRIES, 'payload' => $payload]
        );
    }

    /**
     * Build Slack-compatible payload from domain Notification object.
     *
     * @param Notification $notification
     * @return array<string, mixed>
     */
    private function mapNotificationToPayload(Notification $notification): array
    {
        $attachments = [];
        $context     = $notification->getContext();

        if (!empty($context)) {
            $attachments[] = [
                'color'  => $this->getSeverityColor($notification->getSeverity()),
                'fields' => $this->contextToFields($context),
                'ts'     => (new DateTimeImmutable())->getTimestamp(),
            ];
        }

        return [
            'channel'     => $notification->getChannel() ?: $this->defaultChannel,
            'username'    => $this->username,
            'icon_emoji'  => $this->iconEmoji,
            'text'        => sprintf('[%s] %s', strtoupper($notification->getSeverity()), $notification->getMessage()),
            'attachments' => $attachments,
        ];
    }

    /**
     * Convert severity → Slack hex color.
     */
    private function getSeverityColor(string $severity): string
    {
        return match (strtolower($severity)) {
            'critical' => '#e01e5a', // red
            'high'     => '#ff8c00', // orange
            'medium'   => '#ecb22e', // yellow
            'low'      => '#439fe0', // blue
            default    => '#2eb886', // green
        };
    }

    /**
     * @param array<string, mixed> $context
     * @return array<int, array<string, mixed>>
     */
    private function contextToFields(array $context): array
    {
        $fields = [];
        foreach ($context as $key => $value) {
            $fields[] = [
                'title' => ucfirst((string) $key),
                'value' => is_scalar($value)
                    ? (string) $value
                    : json_encode($value, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT),
                'short' => true,
            ];
        }

        return $fields;
    }

    /**
     * Sleep based on attempt number and optional "Retry-After" header.
     */
    private function sleepWithBackoff(int $attempt, int $retryAfter = 0): void
    {
        $milliseconds = $retryAfter > 0
            ? $retryAfter * 1000
            : (self::BASE_BACKOFF_MS * (2 ** $attempt));

        usleep($milliseconds * 1000);
    }
}
```