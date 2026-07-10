```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Infrastructure\Persistence\Doctrine;

use Doctrine\DBAL\LockMode;
use Doctrine\DBAL\Exception as DBALException;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\OptimisticLockException;
use Doctrine\ORM\QueryBuilder;
use Doctrine\ORM\Tools\Pagination\Paginator;
use Psr\Log\LoggerInterface;
use Ramsey\Uuid\Uuid;
use Ramsey\Uuid\UuidInterface;
use Throwable;
use ProdSecureOrchestrator\Domain\Monitoring\Entity\MonitoredResource;
use ProdSecureOrchestrator\Domain\Monitoring\Repository\MonitoredResourceRepositoryInterface;
use ProdSecureOrchestrator\Domain\Monitoring\ValueObject\ResourceType;
use ProdSecureOrchestrator\Domain\Shared\Exception\EntityNotFoundException;
use ProdSecureOrchestrator\Domain\Shared\ValueObject\EnvironmentId;
use ProdSecureOrchestrator\Domain\Shared\ValueObject\Pagination;

/**
 * Doctrine ORM implementation of the MonitoredResourceRepositoryInterface.
 *
 * The repository encapsulates all persistence-level interactions for the
 * MonitoredResource aggregate, while remaining agnostic of the application
 * layer’s use-cases. Additional responsibilities include:
 *   – Transactional/locking concerns for high-concurrency environments
 *   – Centralised exception handling and logging
 *   – Flexible search API that supports real-world DevSecOps workflows
 *
 * @package ProdSecureOrchestrator\Infrastructure\Persistence\Doctrine
 */
final class MonitoredResourceRepository implements MonitoredResourceRepositoryInterface
{
    public const ALIAS = 'mr';

    private EntityManagerInterface $em;
    private LoggerInterface        $logger;

    public function __construct(EntityManagerInterface $em, LoggerInterface $logger)
    {
        $this->em     = $em;
        $this->logger = $logger;
    }

    /**
     * {@inheritDoc}
     */
    public function nextIdentity(): UuidInterface
    {
        return Uuid::uuid4();
    }

    /**
     * {@inheritDoc}
     */
    public function findById(UuidInterface $id): ?MonitoredResource
    {
        return $this->em->find(MonitoredResource::class, $id);
    }

    /**
     * {@inheritDoc}
     */
    public function get(UuidInterface $id): MonitoredResource
    {
        $entity = $this->findById($id);

        if ($entity === null) {
            throw EntityNotFoundException::for(MonitoredResource::class, $id);
        }

        return $entity;
    }

    /**
     * {@inheritDoc}
     */
    public function save(MonitoredResource $resource, bool $flush = true): void
    {
        try {
            $this->em->persist($resource);

            if ($flush) {
                $this->em->flush();
            }
        } catch (OptimisticLockException | DBALException | Throwable $e) {
            $this->logger->error(
                'Unable to persist MonitoredResource.',
                ['id' => $resource->getId()->toString(), 'exception' => $e]
            );
            throw $e;
        }
    }

    /**
     * {@inheritDoc}
     */
    public function remove(MonitoredResource $resource, bool $flush = true): void
    {
        try {
            $this->em->remove($resource);

            if ($flush) {
                $this->em->flush();
            }
        } catch (OptimisticLockException | DBALException | Throwable $e) {
            $this->logger->error(
                'Unable to remove MonitoredResource.',
                ['id' => $resource->getId()->toString(), 'exception' => $e]
            );
            throw $e;
        }
    }

    /**
     * {@inheritDoc}
     */
    public function search(
        ?EnvironmentId $environmentId = null,
        ?ResourceType  $type          = null,
        ?string        $name          = null,
        ?Pagination    $pagination    = null
    ): Paginator {
        $qb = $this->createSearchQueryBuilder($environmentId, $type, $name);

        if ($pagination !== null) {
            $qb->setFirstResult(($pagination->page() - 1) * $pagination->limit())
               ->setMaxResults($pagination->limit());
        }

        return new Paginator($qb, true);
    }

    /**
     * {@inheritDoc}
     */
    public function lock(MonitoredResource $resource): void
    {
        try {
            // Pessimistic WRITE lock guarantees exclusive access
            $this->em->lock($resource, LockMode::PESSIMISTIC_WRITE);
        } catch (OptimisticLockException | DBALException | Throwable $e) {
            $this->logger->warning(
                'Unable to acquire lock on MonitoredResource.',
                ['id' => $resource->getId()->toString(), 'exception' => $e]
            );
            throw $e;
        }
    }

    /**
     * Flushes the current Unit of Work.
     *
     * This helper exists because callers often batch-persist several entities
     * via save($entity, false) for performance reasons.
     *
     * @throws Throwable
     */
    public function flush(): void
    {
        try {
            $this->em->flush();
        } catch (Throwable $e) {
            $this->logger->critical('Doctrine flush failed.', ['exception' => $e]);
            throw $e;
        }
    }

    /**************************************************************************
     * Internal helpers
     * ***********************************************************************/

    /**
     * Builds a Doctrine QueryBuilder based on dynamic filters.
     */
    private function createSearchQueryBuilder(
        ?EnvironmentId $environmentId,
        ?ResourceType  $type,
        ?string        $name
    ): QueryBuilder {
        $qb = $this->em->createQueryBuilder()
                       ->select(self::ALIAS)
                       ->from(MonitoredResource::class, self::ALIAS);

        if ($environmentId !== null) {
            $qb->andWhere(self::ALIAS . '.environmentId = :environmentId')
               ->setParameter('environmentId', $environmentId->toString());
        }

        if ($type !== null) {
            $qb->andWhere(self::ALIAS . '.type = :type')
               ->setParameter('type', $type->value);
        }

        if ($name !== null) {
            $qb->andWhere('LOWER(' . self::ALIAS . '.name) LIKE :name')
               ->setParameter('name', '%' . mb_strtolower($name) . '%');
        }

        return $qb->orderBy(self::ALIAS . '.name', 'ASC');
    }
}
```