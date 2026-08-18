const assert = require('node:assert').strict;

const Ledger = require('../src/ledger');
const { buildEvidenceCatalog, resolveImplementationCycleId } = require('../src/pr-body-evidence');

function makeCluster() {
  const ledger = new Ledger(':memory:');
  return { id: 'cluster-1', ledger };
}

function appendStaleGate(ledger, clusterId) {
  ledger.append({
    cluster_id: clusterId,
    topic: 'VALIDATION_RESULT',
    sender: 'validator-old',
    content: {
      data: { qualityGates: [{ id: 'stale-gate', status: 'PASS', evidence: { command: 'old' } }] },
    },
  });
}

function appendImplementationReady(ledger, clusterId) {
  return ledger.append({
    cluster_id: clusterId,
    topic: 'IMPLEMENTATION_READY',
    sender: 'worker',
    content: {
      data: {
        qualityGates: [
          {
            id: 'lint',
            status: 'PASS',
            evidence: {
              command: 'npm run lint',
              exitCode: 0,
              output: 'clean',
              environment: 'linux',
            },
          },
        ],
      },
    },
  });
}

function appendValidationResult(ledger, clusterId) {
  ledger.append({
    cluster_id: clusterId,
    topic: 'VALIDATION_RESULT',
    sender: 'validator-1',
    content: {
      data: {
        approved: true,
        qualityGates: [
          {
            id: 'lint',
            status: 'PASS',
            evidence: { command: 'npm run lint', exitCode: 0, output: 'clean (revalidated)' },
          },
          {
            id: 'unit-tests',
            status: 'PASS',
            evidence: { command: 'npm test', exitCode: 0, output: 'all green' },
          },
        ],
      },
    },
  });
}

describe('pr-body-evidence', function () {
  let cluster;

  afterEach(function () {
    cluster.ledger.close();
  });

  it('returns null cycle id and an empty catalog when no IMPLEMENTATION_READY exists', function () {
    cluster = makeCluster();
    assert.equal(resolveImplementationCycleId(cluster), null);
    const catalog = buildEvidenceCatalog(cluster);
    assert.deepEqual(catalog.entries, []);
    assert.deepEqual(catalog.qualityGateIds, []);
  });

  it('collects deduplicated quality gates from IMPLEMENTATION_READY and later VALIDATION_RESULT messages', function () {
    cluster = makeCluster();
    const clusterId = cluster.id;

    // A stale message from a previous cycle must never leak into the catalog.
    appendStaleGate(cluster.ledger, clusterId);
    const implementationReady = appendImplementationReady(cluster.ledger, clusterId);
    appendValidationResult(cluster.ledger, clusterId);

    assert.equal(resolveImplementationCycleId(cluster), implementationReady.id);

    const catalog = buildEvidenceCatalog(cluster);
    const ids = catalog.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ['lint', 'unit-tests']);
    assert.equal(catalog.qualityGateIds.sort().join(','), 'lint,unit-tests');
    assert.ok(!catalog.qualityGateIds.includes('stale-gate'));
    assert.ok(catalog.ledgerRefIds.includes(implementationReady.id));

    const lintEntry = catalog.entries.find((e) => e.id === 'lint');
    // First occurrence (from IMPLEMENTATION_READY) wins over the later duplicate.
    assert.equal(lintEntry.command, 'npm run lint');
    assert.equal(lintEntry.environment, 'linux');

    const unitEntry = catalog.entries.find((e) => e.id === 'unit-tests');
    assert.equal(unitEntry.environment, 'not recorded');
  });
});
