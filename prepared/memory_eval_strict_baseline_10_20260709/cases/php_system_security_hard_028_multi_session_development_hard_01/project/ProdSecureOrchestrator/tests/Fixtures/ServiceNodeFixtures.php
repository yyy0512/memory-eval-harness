<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Fixtures;

use Doctrine\Bundle\FixturesBundle\Fixture;
use Doctrine\Common\DataFixtures\DependentFixtureInterface;
use Doctrine\Persistence\ObjectManager;
use Faker\Factory as Faker;
use ProdSecureOrchestrator\Domain\Node\Entity\ServiceNode;
use ProdSecureOrchestrator\Domain\Node\ValueObject\NodeHealthStatus;
use ProdSecureOrchestrator\Domain\Shared\ValueObject\Ulid;
use ProdSecureOrchestrator\Tests\Fixtures\Traits\ReferenceableFixtureTrait;

/**
 * Test-data fixture that seeds the test database with
 * representative ServiceNode entities.
 *
 * The data set emulates a cross-section of the real-world
 * micro-service topologies ProdSecure Orchestrator manipulates,
 * thereby allowing PHPUnit functional tests to run deterministically
 * while still reflecting production-grade scenarios.
 *
 * @internal Fixtures should never leak outside the `Tests` namespace.
 */
final class ServiceNodeFixtures extends Fixture implements DependentFixtureInterface
{
    use ReferenceableFixtureTrait;

    public const REF_ALERTING_NODE   = 'service_node_alerting';
    public const REF_METRICS_NODE    = 'service_node_metrics';
    public const REF_BACKUP_NODE     = 'service_node_backup';

    /**
     * @inheritDoc
     *
     * @throws \Throwable
     */
    public function load(ObjectManager $manager): void
    {
        $faker = Faker::create();

        /** @var array<string, array{role:string,port:int}> $nodesData */
        $nodesData = [
            self::REF_ALERTING_NODE => [
                'role' => 'alerting',
                'port' => 8081,
            ],
            self::REF_METRICS_NODE => [
                'role' => 'metrics',
                'port' => 9100,
            ],
            self::REF_BACKUP_NODE => [
                'role' => 'backup',
                'port' => 5400,
            ],
        ];

        foreach ($nodesData as $referenceKey => $data) {
            $serviceNode = new ServiceNode(
                Ulid::generate(),
                $data['role'],
                $faker->ipv4(),
                $data['port'],
                // Randomize health so tests can cover multiple branches
                NodeHealthStatus::fromString($faker->randomElement([
                    NodeHealthStatus::STATUS_HEALTHY,
                    NodeHealthStatus::STATUS_DEGRADED,
                    NodeHealthStatus::STATUS_DOWN,
                ])),
                [
                    'os'          => $faker->linuxPlatformToken,
                    'agent_ver'   => $faker->semver(false),
                    'deploy_tag'  => strtoupper($faker->bothify('v###-##-prod')),
                ]
            );

            $manager->persist($serviceNode);

            // Make this entity retrievable via $this->getReference(...) in other fixtures/tests.
            $this->addReference($referenceKey, $serviceNode);
        }

        $manager->flush();
    }

    /**
     * Express fixture dependencies to guarantee foreign keys resolve.
     *
     * @return array<class-string<Fixture>>
     */
    public function getDependencies(): array
    {
        // Example: Service nodes might belong to clusters seeded earlier.
        // Return [] for now to keep this fixture self-contained.
        return [];
    }
}