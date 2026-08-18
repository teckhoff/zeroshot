const assert = require('node:assert').strict;

const Ledger = require('../src/ledger');
const { validatePrBodyHook } = require('../src/agent/pr-body-authoring');
const { loadUnrealhogTemplate, loadUnrealhogCompletedBody } = require('./helpers/pr-body-fixtures');

const { content: TEMPLATE, sha256: TEMPLATE_SHA256 } = loadUnrealhogTemplate();
const VALID_BODY = loadUnrealhogCompletedBody();

function makeAgent(cluster) {
  const published = [];
  return {
    cluster,
    workingDirectory: '/tmp/worktree-fake',
    _log: () => {},
    _publish: (message) => published.push(message),
    published,
  };
}

function makeCluster(prBodyTemplate) {
  const ledger = new Ledger(':memory:');
  return { id: 'cluster-x', ledger, prOptions: { prBodyMode: 'template-file', prBodyTemplate } };
}

function appendImplementationReady(cluster) {
  return cluster.ledger.append({
    cluster_id: cluster.id,
    topic: 'IMPLEMENTATION_READY',
    sender: 'worker',
    content: {
      data: {
        qualityGates: [
          {
            id: 'gate-tests',
            status: 'PASS',
            evidence: { command: 'npm test', exitCode: 0, output: 'all green' },
          },
        ],
      },
    },
  });
}

describe('validatePrBodyHook', function () {
  let cluster;

  afterEach(function () {
    cluster.ledger.close();
  });

  it('publishes PR_BODY_READY for a valid candidate on the first attempt', function () {
    const prBodyTemplate = {
      sourcePath: '.github/pull_request_template.md',
      content: TEMPLATE,
      sha256: TEMPLATE_SHA256,
    };
    cluster = makeCluster(prBodyTemplate);
    const implementationReady = appendImplementationReady(cluster);
    const agent = makeAgent(cluster);

    validatePrBodyHook({
      result: {
        parsedResult: {
          template_sha256: TEMPLATE_SHA256,
          body: VALID_BODY,
          evidence_refs: ['gate-tests'],
          section_evidence: [{ heading_ordinal: 2, evidence_refs: ['gate-tests'] }],
        },
      },
      agent,
    });

    assert.equal(agent.published.length, 1);
    assert.equal(agent.published[0].topic, 'PR_BODY_READY');
    const data = agent.published[0].content.data;
    assert.equal(data.templateSha256, TEMPLATE_SHA256);
    assert.equal(data.implementationCycleId, implementationReady.id);
    assert.equal(data.attemptCount, 1);
    assert.equal(data.canonicalBody, VALID_BODY.replace(/\r\n/g, '\n'));
    assert.match(data.canonicalBodySha256, /^[0-9a-f]{64}$/);
  });

  it('publishes PR_BODY_REVISION_REQUESTED (without throwing) on the first invalid candidate', function () {
    const prBodyTemplate = {
      sourcePath: '.github/pull_request_template.md',
      content: TEMPLATE,
      sha256: TEMPLATE_SHA256,
    };
    cluster = makeCluster(prBodyTemplate);
    appendImplementationReady(cluster);
    const agent = makeAgent(cluster);

    validatePrBodyHook({
      result: {
        parsedResult: {
          template_sha256: TEMPLATE_SHA256,
          body: VALID_BODY.replace('## Docs update', '## Renamed Section'),
          evidence_refs: [],
          section_evidence: [{ heading_ordinal: 2, evidence_refs: ['gate-tests'] }],
        },
      },
      agent,
    });

    assert.equal(agent.published.length, 1);
    assert.equal(agent.published[0].topic, 'PR_BODY_REVISION_REQUESTED');
    const data = agent.published[0].content.data;
    assert.equal(data.attemptCount, 1);
    assert.ok(data.violations.some((v) => v.rule === 'R4'));
  });

  it('publishes PR_BODY_AUTHORING_FAILED and throws on the second invalid candidate', function () {
    const prBodyTemplate = {
      sourcePath: '.github/pull_request_template.md',
      content: TEMPLATE,
      sha256: TEMPLATE_SHA256,
    };
    cluster = makeCluster(prBodyTemplate);
    appendImplementationReady(cluster);

    // Simulate the one prior correction attempt already recorded in the ledger.
    cluster.ledger.append({
      cluster_id: cluster.id,
      topic: 'PR_BODY_REVISION_REQUESTED',
      sender: 'pr-body-author',
      content: { data: { violations: [], headingOrdinals: [], attemptCount: 1 } },
    });

    const agent = makeAgent(cluster);
    const badResult = {
      parsedResult: {
        template_sha256: TEMPLATE_SHA256,
        body: VALID_BODY.replace('## Docs update', '## Renamed Section'),
        evidence_refs: [],
        section_evidence: [{ heading_ordinal: 2, evidence_refs: ['gate-tests'] }],
      },
    };

    assert.throws(
      () => validatePrBodyHook({ result: badResult, agent }),
      /PR_BODY_AUTHORING_FAILED/
    );
    assert.equal(agent.published.length, 1);
    assert.equal(agent.published[0].topic, 'PR_BODY_AUTHORING_FAILED');
    const data = agent.published[0].content.data;
    assert.equal(data.attemptCount, 2);
    assert.equal(data.sourcePath, '.github/pull_request_template.md');
    assert.equal(data.worktreePath, '/tmp/worktree-fake');
  });

  it('throws a clear error when the cluster has no prBodyTemplate snapshot', function () {
    cluster = makeCluster(null);
    const agent = makeAgent(cluster);
    assert.throws(
      () => validatePrBodyHook({ result: { parsedResult: {} }, agent }),
      /prOptions\.prBodyTemplate/
    );
  });
});
