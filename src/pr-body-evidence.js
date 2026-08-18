/**
 * Builds the bounded quality-gate evidence catalog the PR-body author and
 * deterministic validator use, scoped to the latest implementation cycle.
 */

const OUTPUT_EXCERPT_MAX_CHARS = 2000;
const NOT_RECORDED = 'not recorded';

function messagePayload(msg) {
  if (msg && msg.content && msg.content.data && typeof msg.content.data === 'object') {
    return msg.content.data;
  }
  return {};
}

function messageQualityGates(msg) {
  const payload = messagePayload(msg);
  return Array.isArray(payload.qualityGates) ? payload.qualityGates : [];
}

function gateEvidence(gate) {
  if (gate && gate.evidence && typeof gate.evidence === 'object') return gate.evidence;
  return {};
}

function gateId(gate) {
  if (typeof gate.id === 'string' && gate.id.trim() !== '') return gate.id.trim();
  if (typeof gate.name === 'string' && gate.name.trim() !== '') return gate.name.trim();
  return null;
}

function gateEnvironment(evidence) {
  if (typeof evidence.environment === 'string' && evidence.environment.trim() !== '') {
    return evidence.environment;
  }
  return NOT_RECORDED;
}

function gateCompletedAt(gate, evidence) {
  if (typeof gate.completedAt === 'string' || typeof gate.completedAt === 'number')
    return gate.completedAt;
  if (typeof evidence.completedAt === 'string' || typeof evidence.completedAt === 'number') {
    return evidence.completedAt;
  }
  return null;
}

function gateOutputExcerpt(evidence) {
  const output = typeof evidence.output === 'string' ? evidence.output : '';
  return output.length > OUTPUT_EXCERPT_MAX_CHARS
    ? output.slice(0, OUTPUT_EXCERPT_MAX_CHARS)
    : output;
}

/**
 * @param {object} gate - raw quality gate record from VALIDATION_RESULT/IMPLEMENTATION_READY payload
 * @returns {{id:string, command:string, status:string, exitCode:*, outputExcerpt:string, completedAt:*, environment:string}|null}
 */
function normalizeQualityGateEntry(gate) {
  if (!gate || typeof gate !== 'object') return null;
  const id = gateId(gate);
  if (!id) return null;
  const evidence = gateEvidence(gate);
  return {
    id,
    command: typeof evidence.command === 'string' ? evidence.command : '',
    status: typeof gate.status === 'string' ? gate.status : '',
    exitCode: evidence.exitCode !== undefined ? evidence.exitCode : null,
    outputExcerpt: gateOutputExcerpt(evidence),
    completedAt: gateCompletedAt(gate, evidence),
    environment: gateEnvironment(evidence),
  };
}

function collectEntriesFromMessages(messages) {
  const entries = [];
  const seenIds = new Set();
  for (const msg of messages) {
    for (const gate of messageQualityGates(msg)) {
      const entry = normalizeQualityGateEntry(gate);
      if (!entry || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * @param {object} cluster - live cluster context with .id and .ledger
 * @returns {object|null} the latest IMPLEMENTATION_READY message, or null if none exists
 */
function findLastImplementationReady(cluster) {
  return cluster.ledger.findLast({ cluster_id: cluster.id, topic: 'IMPLEMENTATION_READY' });
}

/**
 * @param {object} cluster
 * @returns {string|null} the ledger message id of the latest IMPLEMENTATION_READY, or null
 */
function resolveImplementationCycleId(cluster) {
  const lastImplementationReady = findLastImplementationReady(cluster);
  return lastImplementationReady ? lastImplementationReady.id : null;
}

/**
 * @param {object} cluster - live cluster context with .id and .ledger
 * @returns {{entries:Array<object>, qualityGateIds:string[], ledgerRefIds:string[]}}
 */
function buildEvidenceCatalog(cluster) {
  const clusterId = cluster.id;
  const ledger = cluster.ledger;
  const lastImplementationReady = findLastImplementationReady(cluster);
  const sinceTimestamp = lastImplementationReady ? lastImplementationReady.timestamp : 0;

  const messagesSince = ledger.query({ cluster_id: clusterId, since: sinceTimestamp });
  const ledgerRefIds = messagesSince.map((msg) => msg.id);
  if (lastImplementationReady && !ledgerRefIds.includes(lastImplementationReady.id)) {
    ledgerRefIds.push(lastImplementationReady.id);
  }

  const validationResults = ledger.query({
    cluster_id: clusterId,
    topic: 'VALIDATION_RESULT',
    since: sinceTimestamp,
  });
  const gateSourceMessages = lastImplementationReady
    ? [lastImplementationReady, ...validationResults]
    : validationResults;

  const entries = collectEntriesFromMessages(gateSourceMessages);

  return {
    entries,
    qualityGateIds: entries.map((entry) => entry.id),
    ledgerRefIds,
  };
}

module.exports = {
  buildEvidenceCatalog,
  resolveImplementationCycleId,
};
