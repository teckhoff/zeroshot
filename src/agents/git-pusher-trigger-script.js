/**
 * Shared trigger logic for detecting when all validators have approved.
 *
 * Extracted from git-pusher-template.js so agents that only need the trigger
 * (e.g. the pr-body-author) can depend on it without pulling in git-pusher's
 * heavier platform-command and repo-settings dependency chain.
 */

const SHARED_TRIGGER_SCRIPT = `const validators = cluster.getAgentsByRole('validator');
const lastPush = ledger.findLast({ topic: 'IMPLEMENTATION_READY' });
if (!lastPush) return false;

function isApproved(value) {
  return value === true || value === 'true';
}

function getPayload(msg) {
  return msg?.content?.['data'] || {};
}

function getEvidence(gate) {
  return gate?.evidence && typeof gate.evidence === 'object' ? gate.evidence : {};
}

function getGateId(gate) {
  if (typeof gate?.id === 'string' && gate.id.trim() !== '') return gate.id.trim();
  const gateName = gate?.['name'];
  if (typeof gateName === 'string' && gateName.trim() !== '') return gateName.trim();
  return null;
}

function normalizeGateRequirements(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const gate of value) {
    if (typeof gate === 'string') {
      const id = gate.trim();
      if (id) normalized.push({ id });
      continue;
    }
    if (!gate || typeof gate !== 'object') continue;
    const id = getGateId(gate);
    if (!id) continue;
    const required = { id };
    if (typeof gate.scope === 'string' && gate.scope.trim() !== '') {
      required.scope = gate.scope.trim();
    }
    normalized.push(required);
  }
  return normalized;
}

function getRequiredQualityGates() {
  const currentAgent =
    typeof cluster.getAgent === 'function' ? cluster.getAgent(agent.id) : null;
  const sources = [
    agent.requiredQualityGates,
    currentAgent?.requiredQualityGates,
    currentAgent?.config?.requiredQualityGates,
  ];
  for (const source of sources) {
    const gates = normalizeGateRequirements(source);
    if (gates.length > 0) return gates;
  }
  return [];
}

function collectQualityGates(msg) {
  const gateData = getPayload(msg);
  return Array.isArray(gateData.qualityGates) ? gateData.qualityGates : [];
}

function toTimestamp(timestampInput) {
  const value = timestampInput;
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (isFinite(parsed)) return parsed;
  }
  return null;
}

function qualityGateTimestamp(gate, msg) {
  const evidence = getEvidence(gate);
  return (
    toTimestamp(gate?.timestamp) ||
    toTimestamp(gate?.validatedAt) ||
    toTimestamp(gate?.completedAt) ||
    toTimestamp(evidence.timestamp) ||
    toTimestamp(evidence.validatedAt) ||
    toTimestamp(evidence.completedAt)
  );
}

function describeQualityGate(gate, msg, required) {
  const evidence = getEvidence(gate);
  const parts = [];
  const gateId = getGateId(gate) || required?.id;
  const scope = gate?.scope || evidence.scope || required?.scope;
  const status = gate?.status;
  const exitCode = evidence.exitCode;
  const command = evidence.command;
  const output = evidence.output || gate?.reason || evidence.reason;
  if (gateId) parts.push('gate=' + gateId);
  if (scope) parts.push('scope=' + scope);
  if (status) parts.push('status=' + status);
  if (exitCode !== undefined) parts.push('exitCode=' + exitCode);
  if (command) parts.push('command=' + JSON.stringify(String(command).slice(0, 160)));
  if (msg?.sender) parts.push('sender=' + msg.sender);
  if (output) parts.push('output=' + JSON.stringify(String(output).slice(0, 240)));
  if (!output && (gate?.reason || evidence.reason)) {
    parts.push('reason=' + JSON.stringify(String(gate?.reason || evidence.reason).slice(0, 240)));
  }
  return parts.join(' ');
}

function exitCodePasses(evidence) {
  const exitCode = evidence.exitCode;
  return (
    exitCode === 0 ||
    exitCode === '0' ||
    (typeof exitCode === 'string' && exitCode.trim() !== '' && Number(exitCode) === 0)
  );
}

function qualityGateMatches(gate, required) {
  if (getGateId(gate) !== required.id) return false;
  if (required.scope && gate?.scope !== required.scope && getEvidence(gate).scope !== required.scope) {
    return false;
  }
  return true;
}

function compareGateEvidence(left, right) {
  const leftTimestamp = qualityGateTimestamp(left.gate, left.msg) || 0;
  const rightTimestamp = qualityGateTimestamp(right.gate, right.msg) || 0;
  return leftTimestamp - rightTimestamp;
}

function findLatestQualityGate(messages, required) {
  let latest = null;
  for (const msg of messages) {
    for (const gate of collectQualityGates(msg)) {
      if (!qualityGateMatches(gate, required)) continue;
      const candidate = { gate, msg };
      if (!latest || compareGateEvidence(candidate, latest) >= 0) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function getQualityGateBlockingReasons(gate, msg) {
  const reasons = [];
  const status = String(gate?.status || '').toUpperCase();
  if (status !== 'PASS') reasons.push('status=' + (gate?.status || 'missing'));

  const evidence = getEvidence(gate);
  if (typeof evidence.command !== 'string' || evidence.command.trim() === '') {
    reasons.push('missing evidence.command');
  }
  if (!exitCodePasses(evidence)) {
    reasons.push('evidence.exitCode=' + evidence.exitCode);
  }
  if (typeof evidence.output !== 'string') {
    reasons.push('missing evidence.output');
  }
  if (gate?.stale === true || evidence.stale === true) {
    reasons.push('stale=true');
  }
  const completedAt = qualityGateTimestamp(gate, msg);
  if (completedAt === null) {
    reasons.push('missing completedAt');
  } else if (completedAt < lastPush.timestamp) {
    reasons.push('completed before IMPLEMENTATION_READY');
  }
  return reasons;
}

function assertRequiredQualityGatesPass(messages) {
  if (requiredQualityGatesForHandoff.length === 0) return true;

  for (const required of requiredQualityGatesForHandoff) {
    const found = findLatestQualityGate(messages, required);
    if (!found) {
      throw new Error(
        'Required quality gate missing for git-pusher handoff: gate=' + required.id
      );
    }

    const reasons = getQualityGateBlockingReasons(found.gate, found.msg);
    if (reasons.length > 0) {
      throw new Error(
        'Required quality gate blocked git-pusher handoff: ' +
          describeQualityGate(found.gate, found.msg, required) +
          ' reason=' +
          JSON.stringify(reasons.join(', '))
      );
    }
  }

  return true;
}

const requiredQualityGatesForHandoff = getRequiredQualityGates();
if (validators.length === 0 && requiredQualityGatesForHandoff.length === 0) return true;

const results = ledger.query({ topic: 'VALIDATION_RESULT', since: lastPush.timestamp });
if (results.length === 0) return false;

const validatorIds = new Set(validators.map((v) => v.id));
const validatorResults = results.filter((r) => validatorIds.has(r.sender));

// Two supported patterns:
// 1) Per-validator VALIDATION_RESULT (sender is a validator) → require all validators approve.
// 2) Consensus-only VALIDATION_RESULT (sender is coordinator) -> use latest result.
if (validatorResults.length === 0) {
  let latest = null;
  for (const msg of results) {
    if (!latest || (typeof msg.timestamp === 'number' && msg.timestamp > latest.timestamp)) {
      latest = msg;
    }
  }
  const approved = getPayload(latest).approved;
  if (!isApproved(approved)) return false;
  assertRequiredQualityGatesPass([latest]);
  return true;
}

const latestByValidator = new Map();
for (const msg of validatorResults) {
  latestByValidator.set(msg.sender, msg);
}
if (latestByValidator.size < validators.length) return false;

for (const validator of validators) {
  const msg = latestByValidator.get(validator.id);
  const approved = getPayload(msg).approved;
  if (!isApproved(approved)) return false;
}

const latestValidatorMessages = Array.from(latestByValidator.values());
assertRequiredQualityGatesPass(latestValidatorMessages);

const hasSufficientEvidence = latestValidatorMessages.every((r) => {
  const criteria = getPayload(r).criteriaResults;
  if (!Array.isArray(criteria) || criteria.length === 0) return true;
  return criteria.every((c) => {
    const status = String(c.status || '').toUpperCase();
    if (status === 'CANNOT_VALIDATE') return true;
    if (status === 'SKIPPED') return true;
    if (status === 'CANNOT_VALIDATE_YET') return false;
    const evidence = c.evidence || {};
    const hasCommand = typeof evidence.command === 'string' && evidence.command.trim().length > 0;
    const exitCode = evidence.exitCode;
    const hasExitCode =
      typeof exitCode === 'number' ||
      (typeof exitCode === 'string' && exitCode.trim() !== '' && isFinite(Number(exitCode)));
    const hasOutput = evidence.output === undefined || typeof evidence.output === 'string';
    return hasCommand && hasExitCode && hasOutput;
  });
});

return hasSufficientEvidence;`;

module.exports = { SHARED_TRIGGER_SCRIPT };
