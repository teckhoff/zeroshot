/**
 * PR-body-template-file authoring hook.
 *
 * Runs deterministic validation on the pr-body-author agent's structured
 * output against the immutable template snapshot and the bounded run
 * evidence catalog. Valid candidates publish PR_BODY_READY (consumed by the
 * orchestrator to inject the transport-only git-pusher). Invalid candidates
 * get one correction attempt (PR_BODY_REVISION_REQUESTED) before terminal
 * failure (PR_BODY_AUTHORING_FAILED). The attempt count is always derived
 * from the ledger, never from in-memory state, so resume is exact.
 */

const { validatePrBodyCandidate, canonicalizeBody, hashBody } = require('../pr-body-validator');
const { buildEvidenceCatalog, resolveImplementationCycleId } = require('../pr-body-evidence');

const MAX_ATTEMPTS = 2;

function resolveCycleTimestamp(cluster) {
  const lastImplementationReady = cluster.ledger.findLast({
    cluster_id: cluster.id,
    topic: 'IMPLEMENTATION_READY',
  });
  return lastImplementationReady ? lastImplementationReady.timestamp : 0;
}

function resolveAttemptCount(cluster, cycleTimestamp) {
  const priorRevisions = cluster.ledger.query({
    cluster_id: cluster.id,
    topic: 'PR_BODY_REVISION_REQUESTED',
    since: cycleTimestamp,
  }).length;
  return 1 + priorRevisions;
}

function requireTemplateSnapshot(cluster) {
  const prBodyTemplate = cluster.prOptions ? cluster.prOptions.prBodyTemplate : null;
  if (!prBodyTemplate) {
    throw new Error(
      'validatePrBodyHook requires cluster.prOptions.prBodyTemplate (prBodyMode: "template-file").'
    );
  }
  return prBodyTemplate;
}

function headingOrdinalsOf(violations) {
  const ordinals = new Set();
  for (const violation of violations) {
    if (violation.headingOrdinal !== null && violation.headingOrdinal !== undefined) {
      ordinals.add(violation.headingOrdinal);
    }
  }
  return Array.from(ordinals).sort((a, b) => a - b);
}

function publishPrBodyReady({
  agent,
  prBodyTemplate,
  implementationCycleId,
  candidate,
  attemptCount,
}) {
  const canonicalBody = canonicalizeBody(candidate.body);
  const canonicalBodySha256 = hashBody(canonicalBody);
  agent._log(
    `✅ PR body validated (attempt ${attemptCount}): template=${prBodyTemplate.sourcePath} ` +
      `digest=${canonicalBodySha256.slice(0, 12)}`
  );
  agent._publish({
    topic: 'PR_BODY_READY',
    content: {
      data: {
        templateSha256: prBodyTemplate.sha256,
        implementationCycleId,
        canonicalBody,
        canonicalBodySha256,
        evidenceRefs: Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs : [],
        sectionEvidence: Array.isArray(candidate.section_evidence)
          ? candidate.section_evidence
          : [],
        attemptCount,
      },
    },
  });
}

function publishRevisionRequested({ agent, violations, attemptCount }) {
  const ruleIds = violations.map((v) => v.rule);
  const headingOrdinals = headingOrdinalsOf(violations);
  agent._log(
    `🔁 PR body candidate rejected (attempt ${attemptCount}); one correction remains. ` +
      `Rules: ${ruleIds.join(', ')}. Headings: ${headingOrdinals.join(', ') || 'none'}.`
  );
  agent._publish({
    topic: 'PR_BODY_REVISION_REQUESTED',
    content: {
      data: { violations, headingOrdinals, attemptCount },
    },
  });
}

function publishAuthoringFailed({ agent, prBodyTemplate, violations, attemptCount }) {
  const ruleIds = violations.map((v) => v.rule);
  const headingOrdinals = headingOrdinalsOf(violations);
  agent._log(
    `🔴 PR body authoring failed after ${attemptCount} attempts. Rules: ${ruleIds.join(', ')}. ` +
      `Headings: ${headingOrdinals.join(', ') || 'none'}.`
  );
  agent._publish({
    topic: 'PR_BODY_AUTHORING_FAILED',
    content: {
      data: {
        violations,
        headingOrdinals,
        attemptCount,
        worktreePath: agent.workingDirectory,
        sourcePath: prBodyTemplate.sourcePath,
        templateSha256: prBodyTemplate.sha256,
        remediation:
          "Inspect the rejected candidate in this cycle's agent output for the violated rules above, " +
          'then either complete Git/PR delivery manually from the preserved worktree, or start a new run ' +
          'with a final literal --pr-body instead of --pr-body-template-file.',
      },
    },
  });
}

/**
 * @param {{result:object, agent:object}} params
 */
function validatePrBodyHook({ result, agent }) {
  const cluster = agent.cluster;
  const candidate = result.parsedResult;
  const prBodyTemplate = requireTemplateSnapshot(cluster);

  const cycleTimestamp = resolveCycleTimestamp(cluster);
  const implementationCycleId = resolveImplementationCycleId(cluster);
  const evidenceCatalog = buildEvidenceCatalog(cluster);

  const { valid, violations } = validatePrBodyCandidate({
    candidate,
    template: prBodyTemplate.content,
    templateSha256: prBodyTemplate.sha256,
    evidenceCatalog,
    qualityGateIds: evidenceCatalog.qualityGateIds,
    ledgerRefIds: evidenceCatalog.ledgerRefIds,
  });

  const attemptCount = resolveAttemptCount(cluster, cycleTimestamp);

  if (valid) {
    publishPrBodyReady({ agent, prBodyTemplate, implementationCycleId, candidate, attemptCount });
    return;
  }

  if (attemptCount < MAX_ATTEMPTS) {
    publishRevisionRequested({ agent, violations, attemptCount });
    return;
  }

  publishAuthoringFailed({ agent, prBodyTemplate, violations, attemptCount });
  throw new Error(
    `PR_BODY_AUTHORING_FAILED: candidate PR body failed deterministic validation after ${attemptCount} ` +
      `attempts. Violated rules: ${violations.map((v) => v.rule).join(', ')}.`
  );
}

module.exports = {
  validatePrBodyHook,
};
