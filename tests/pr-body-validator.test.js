const assert = require('node:assert').strict;

const { validatePrBodyCandidate, canonicalizeBody, hashBody } = require('../src/pr-body-validator');
const { renderPullRequestBody } = require('../src/pr-body-template');
const { loadUnrealhogTemplate, loadUnrealhogCompletedBody } = require('./helpers/pr-body-fixtures');

const { content: TEMPLATE, sha256: TEMPLATE_SHA256 } = loadUnrealhogTemplate();

const QUALITY_GATE = {
  id: 'gate-tests',
  command: 'npm test',
  status: 'PASS',
  exitCode: 0,
  outputExcerpt: 'all green',
  completedAt: 1000,
  environment: 'linux',
};

const HAPPY_BODY = loadUnrealhogCompletedBody();

function baseParams(overrides = {}) {
  return {
    candidate: {
      template_sha256: TEMPLATE_SHA256,
      body: HAPPY_BODY,
      evidence_refs: ['gate-tests'],
      section_evidence: [{ heading_ordinal: 2, evidence_refs: ['gate-tests'] }],
    },
    template: TEMPLATE,
    templateSha256: TEMPLATE_SHA256,
    evidenceCatalog: { entries: [QUALITY_GATE] },
    qualityGateIds: ['gate-tests'],
    ledgerRefIds: ['msg-1', 'msg-2'],
    ...overrides,
  };
}

function rulesOf(result) {
  return result.violations.map((v) => v.rule);
}

describe('validatePrBodyCandidate happy path', function () {
  it('accepts a fully populated UnrealHog-shaped candidate', function () {
    const result = validatePrBodyCandidate(baseParams());
    assert.deepEqual(result.violations, []);
    assert.equal(result.valid, true);
  });
});

describe('validatePrBodyCandidate per-rule failures', function () {
  it('R1: rejects a template_sha256 mismatch', function () {
    const params = baseParams({
      candidate: { ...baseParams().candidate, template_sha256: 'deadbeef' },
    });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R1'));
  });

  it('R2: rejects an oversized candidate body', function () {
    const params = baseParams({
      candidate: { ...baseParams().candidate, body: HAPPY_BODY + 'x'.repeat(70000) },
    });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R2'));
  });

  it('R3: rejects an unresolved issue token', function () {
    const body = HAPPY_BODY.replace('Closes #42.', '{{issue_reference}}');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R3'));
  });

  it('R4: rejects an added heading', function () {
    const body = HAPPY_BODY + '\n## Extra\nsurprise section\n';
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r4 = result.violations.filter((v) => v.rule === 'R4');
    assert.ok(r4.length > 0);
    assert.equal(r4[0].headingOrdinal, 5);
  });

  it('R4: rejects a removed heading', function () {
    const body = HAPPY_BODY.replace(/## Agent context\n\nAuthored.*\n/s, '');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R4'));
  });

  it('R4: rejects a renamed heading', function () {
    const body = HAPPY_BODY.replace('## Docs update', '## Documentation update');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r4 = result.violations.filter((v) => v.rule === 'R4');
    assert.ok(r4.some((v) => v.headingOrdinal === 3));
  });

  it('R4: rejects reordered headings', function () {
    const sections = HAPPY_BODY.split(/(?=^## )/m);
    const reordered = [sections[0], sections[2], sections[1], sections[3], sections[4]].join('');
    const params = baseParams({ candidate: { ...baseParams().candidate, body: reordered } });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R4'));
  });

  it('R4: rejects a re-leveled heading', function () {
    const body = HAPPY_BODY.replace('## testing', '### testing');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r4 = result.violations.filter((v) => v.rule === 'R4');
    assert.ok(r4.some((v) => v.headingOrdinal === 2));
  });

  it('R5: rejects a comment-only section', function () {
    const body = HAPPY_BODY.replace(
      /## Docs update\n\nNo docs impact\.\n/,
      '## Docs update\n\n<!-- fill this in -->\n'
    );
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r5 = result.violations.filter((v) => v.rule === 'R5');
    assert.ok(r5.some((v) => v.headingOrdinal === 3));
  });

  it('R6: rejects an empty heading-free candidate', function () {
    const params = baseParams({
      template: '',
      templateSha256: hashBody(''),
      candidate: {
        template_sha256: hashBody(''),
        body: '<!-- nothing here -->',
        evidence_refs: [],
        section_evidence: [],
      },
    });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R6'));
  });

  it('R7: fenced code containing "#" is not mistaken for an added heading', function () {
    const body = HAPPY_BODY.replace(
      '## Changes\n\n',
      '## Changes\n\n```markdown\n# not a heading\n```\n\n'
    );
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    assert.equal(rulesOf(result).includes('R4'), false);
  });

  it('R8: rejects a stale evidence reference', function () {
    const params = baseParams({
      candidate: {
        ...baseParams().candidate,
        evidence_refs: ['stale-ref'],
      },
    });
    const result = validatePrBodyCandidate(params);
    assert.ok(rulesOf(result).includes('R8'));
  });

  it('R9: rejects a testing section with no quality-gate evidence reference', function () {
    const params = baseParams({
      candidate: { ...baseParams().candidate, section_evidence: [] },
    });
    const result = validatePrBodyCandidate(params);
    const r9 = result.violations.filter((v) => v.rule === 'R9');
    assert.ok(r9.some((v) => v.headingOrdinal === 2));
  });

  it('R10: rejects a section that alters the recorded exit code', function () {
    const body = HAPPY_BODY.replace('exitCode 0.', 'exitCode 1.');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r10 = result.violations.filter((v) => v.rule === 'R10');
    assert.ok(r10.some((v) => v.headingOrdinal === 2));
  });

  it('R10: rejects a section missing the exact evidence command', function () {
    const body = HAPPY_BODY.replace('`npm test`', '`npm run test`');
    const params = baseParams({ candidate: { ...baseParams().candidate, body } });
    const result = validatePrBodyCandidate(params);
    const r10 = result.violations.filter((v) => v.rule === 'R10');
    assert.ok(r10.some((v) => v.headingOrdinal === 2));
  });
});

describe('canonicalizeBody / hashBody', function () {
  it('normalizes CRLF to LF only', function () {
    assert.equal(canonicalizeBody('a\r\nb\rc\nd'), 'a\nb\rc\nd');
  });

  it('hashes canonicalized content deterministically', function () {
    assert.equal(hashBody('same'), hashBody('same'));
    assert.notEqual(hashBody('same'), hashBody('different'));
  });
});

describe('issue token rendering ahead of authoring', function () {
  it('renders all three issue tokens and expands missing metadata to empty text', function () {
    assert.equal(
      renderPullRequestBody('{{issue_number}}|{{issue_title}}|{{issue_reference}}', {
        issueNumber: 42,
        issueTitle: 'Fix the thing',
      }),
      '42|Fix the thing|Closes #42'
    );
    assert.equal(
      renderPullRequestBody('{{issue_number}}|{{issue_title}}|{{issue_reference}}', {}),
      '||'
    );
  });
});
