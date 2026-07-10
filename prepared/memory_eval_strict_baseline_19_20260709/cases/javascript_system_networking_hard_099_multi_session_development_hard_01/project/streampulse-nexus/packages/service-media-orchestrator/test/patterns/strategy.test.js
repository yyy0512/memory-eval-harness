```javascript
/**
 * @file strategy.test.js
 *
 * Purpose:
 *   Validates pluggable load-balancing strategies used by the MediaOrchestrator.
 *   The orchestrator is expected to:
 *     • delegate node-selection decisions to the injected Strategy instance
 *     • support hot-swapping of strategies at runtime
 *     • preserve functional correctness under high concurrency
 *     • enforce a strict strategy contract (presence of `selectNode`)
 *
 * Test Runner:
 *   Jest 29+
 *
 * Important:
 *   – All paths are relative to `packages/service-media-orchestrator`
 *   – When adding new strategies, augment the matrix below accordingly
 */

const { MediaOrchestrator } = require('../../src/orchestrator');
const {
  RoundRobinStrategy,
} = require('../../src/patterns/strategy/roundRobinStrategy');
const {
  HeatMapStrategy,
} = require('../../src/patterns/strategy/heatMapStrategy');

const { v4: uuid } = require('uuid');

/*---------------------------------------------------------------------------
 * Helpers
 *---------------------------------------------------------------------------*/

/**
 * Creates a cluster of N mock nodes with evenly distributed capacity.
 * @param {number} count
 * @returns {import('../../src/types').ClusterNode[]}
 */
function buildMockCluster(count = 5) {
  /* A node has the bare-minimum fields that the orchestrator consumes. */
  return Array.from({ length: count }, (_v, idx) => ({
    id: `edge-${idx}`,
    uri: `wss://edge-${idx}.streampulse.dev`,
    capacity: 10, // concurrent streams supported
    currentLoad: 0,
    region: idx % 2 === 0 ? 'us-east-1' : 'eu-central-1',
    metadata: {},
  }));
}

/**
 * Generates a new stream-session descriptor.
 * @returns {import('../../src/types').StreamSession}
 */
function makeStreamSession() {
  return {
    id: uuid(),
    /*******************************
     * Additional stream metadata  *
     *******************************/
    title: 'Unit-Test Session',
    audience: {
      projectedViewers: Math.floor(Math.random() * 2_000) + 500,
      heatMap: {},
    },
    characteristics: {
      lowLatency: true,
      interactive: false,
    },
  };
}

/*---------------------------------------------------------------------------
 * Tests
 *---------------------------------------------------------------------------*/

describe('Strategy Pattern – MediaOrchestrator', () => {
  let cluster;

  beforeEach(() => {
    /* Fresh cluster for every test to avoid state bleed-over */
    cluster = buildMockCluster(3);
  });

  /*---------------------------------------------------------------------
   * Round-Robin
   *-------------------------------------------------------------------*/
  describe('RoundRobinStrategy', () => {
    it('should cycle through nodes in strict order', () => {
      const rr = new RoundRobinStrategy();
      const orchestrator = new MediaOrchestrator(cluster, rr);

      const allocations = [];
      for (let i = 0; i < 6; i += 1) {
        const session = makeStreamSession();
        allocations.push(orchestrator.allocate(session).id);
      }

      /* 3 nodes => pattern should repeat every 3 allocations      *
       * Expected sequence: [0,1,2,0,1,2]                          */
      expect(allocations).toEqual([
        'edge-0',
        'edge-1',
        'edge-2',
        'edge-0',
        'edge-1',
        'edge-2',
      ]);
    });
  });

  /*---------------------------------------------------------------------
   * Heat-Map (capacity-aware)
   *-------------------------------------------------------------------*/
  describe('HeatMapStrategy', () => {
    it('should favour the node with most remaining capacity', () => {
      /* Edge-2 is deliberately overloaded, Edge-0 has largest spare */
      cluster[0].currentLoad = 0; // 10/10 available
      cluster[1].currentLoad = 5; // 5/10 available
      cluster[2].currentLoad = 8; // 2/10 available

      const hm = new HeatMapStrategy();
      const orchestrator = new MediaOrchestrator(cluster, hm);

      const target = orchestrator.allocate(makeStreamSession());

      expect(target.id).toBe('edge-0');
    });
  });

  /*---------------------------------------------------------------------
   * Runtime Strategy Swap
   *-------------------------------------------------------------------*/
  describe('Hot-Swapping strategies at runtime', () => {
    it('should switch behaviour immediately after swap', () => {
      const orchestrator = new MediaOrchestrator(
        cluster,
        new RoundRobinStrategy(),
      );

      /* First allocation uses Round-Robin => edge-0 expected */
      const s1 = orchestrator.allocate(makeStreamSession());
      expect(s1.id).toBe('edge-0');

      /* Swap to Heat-Map (edge-0 has now 9/10 capacity, still best) */
      orchestrator.setStrategy(new HeatMapStrategy());
      const s2 = orchestrator.allocate(makeStreamSession());
      expect(s2.id).toBe('edge-0');

      /* Overload edge-0, make edge-1 more attractive */
      cluster[0].currentLoad = 10; // full
      cluster[1].currentLoad = 3; // 7/10 available
      cluster[2].currentLoad = 9; // 1/10 available

      const s3 = orchestrator.allocate(makeStreamSession());
      expect(s3.id).toBe('edge-1');
    });
  });

  /*---------------------------------------------------------------------
   * Concurrency
   *-------------------------------------------------------------------*/
  describe('Concurrent allocations', () => {
    it('should remain deterministic when handling parallel requests', async () => {
      const orchestrator = new MediaOrchestrator(
        cluster,
        new RoundRobinStrategy(),
      );

      const ROWS = 50;

      /* Flood with parallel allocations to surface race-conditions */
      const tasks = Array.from({ length: ROWS }, () =>
        Promise.resolve(orchestrator.allocate(makeStreamSession())),
      );

      const results = await Promise.all(tasks);

      /* Extract id list and ensure a round-robin distribution ratio */
      const counts = results.reduce((acc, { id }) => {
        acc[id] = (acc[id] || 0) + 1;
        return acc;
      }, {});

      Object.values(counts).forEach((value) =>
        expect(value).toBeCloseTo(ROWS / cluster.length, 1),
      );
    });
  });

  /*---------------------------------------------------------------------
   * Contract enforcement / Guard-rails
   *-------------------------------------------------------------------*/
  describe('Invalid Strategy Contracts', () => {
    it('should throw when strategy lacks `selectNode` method', () => {
      class InvalidStrategy {}
      const invalid = new InvalidStrategy();

      expect(
        () => new MediaOrchestrator(cluster, invalid),
      ).toThrowErrorMatchingInlineSnapshot(
        `"Strategy must implement a 'selectNode(cluster, session)' method."`,
      );
    });
  });
});
```