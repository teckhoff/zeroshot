/**
 * Deterministic (non-model) validation of an authored PR body candidate
 * against its source template and the bounded run-evidence catalog.
 */

const crypto = require('crypto');
const { MAX_PR_BODY_LENGTH } = require('./pr-body-template');
const {
  extractHeadings,
  sectionVisibleContent,
  wholeDocumentVisibleContent,
} = require('./pr-body-headings');

const KNOWN_ISSUE_TOKENS = Object.freeze([
  '{{issue_number}}',
  '{{issue_title}}',
  '{{issue_reference}}',
]);

const TESTING_HEADING_RE = /test|testing|check|validation|verification|quality/;

const RULES = Object.freeze({
  R1: 'candidate template_sha256 must match the stored snapshot digest',
  R2: 'candidate body must be valid UTF-8 text, contain no NUL bytes, and be <= max length',
  R3: 'candidate body must not contain any unresolved issue token',
  R4: 'candidate heading sequence must match the template heading sequence by level and normalized text',
  R5: 'every heading must own nonempty visible content',
  R6: 'a heading-free template must produce a nonempty visible document',
  R7: 'headings inside fenced code or HTML comments are not headings',
  R8: 'every evidence reference must resolve to a current ledger message or quality gate',
  R9: 'testing/validation-shaped sections require at least one quality-gate evidence reference',
  R10: 'section evidence references must match the catalog command, status, and exit code exactly',
});

function canonicalizeBody(value) {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

function hashBody(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasLoneSurrogate(text) {
  // String iteration combines well-formed surrogate pairs into one code
  // point per step; only an unpaired surrogate surfaces in this range.
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}

function outcomeTokens(entry) {
  const tokens = [];
  if (entry.status !== undefined && entry.status !== null) tokens.push(String(entry.status));
  if (entry.exitCode !== undefined && entry.exitCode !== null) tokens.push(String(entry.exitCode));
  return tokens;
}

function normalizeEvidenceEntries(evidenceCatalog) {
  if (Array.isArray(evidenceCatalog)) return evidenceCatalog;
  if (evidenceCatalog && Array.isArray(evidenceCatalog.entries)) return evidenceCatalog.entries;
  return [];
}

function toIdSet(idIterable) {
  return idIterable ? new Set(idIterable) : new Set();
}

function checkDigest(safeCandidate, templateSha256, violations) {
  if (safeCandidate.template_sha256 !== templateSha256) {
    violations.push({
      rule: 'R1',
      headingOrdinal: null,
      detail: `template_sha256 mismatch: expected ${templateSha256}, got ${safeCandidate.template_sha256}`,
    });
  }
}

function checkBodyShape(rawBody, body, violations) {
  if (typeof rawBody !== 'string') {
    violations.push({
      rule: 'R2',
      headingOrdinal: null,
      detail: 'candidate body must be a string',
    });
    return;
  }
  if (hasLoneSurrogate(body)) {
    violations.push({
      rule: 'R2',
      headingOrdinal: null,
      detail: 'candidate body contains invalid UTF-8 (unpaired surrogate)',
    });
  }
  if (body.includes('\0')) {
    violations.push({
      rule: 'R2',
      headingOrdinal: null,
      detail: 'candidate body contains a NUL byte',
    });
  }
  if (body.length > MAX_PR_BODY_LENGTH) {
    violations.push({
      rule: 'R2',
      headingOrdinal: null,
      detail: `candidate body exceeds ${MAX_PR_BODY_LENGTH} characters`,
    });
  }
}

function checkIssueTokens(body, violations) {
  for (const token of KNOWN_ISSUE_TOKENS) {
    if (body.includes(token)) {
      violations.push({
        rule: 'R3',
        headingOrdinal: null,
        detail: `unresolved issue token remains: ${token}`,
      });
    }
  }
}

function describeHeadingMismatch(expected, actual, index) {
  if (!actual) return `heading removed: expected level ${expected.level} "${expected.text}"`;
  if (!expected) return `heading added: level ${actual.level} "${actual.text}"`;
  return `heading changed at position ${index}: expected level ${expected.level} "${expected.normalizedText}", got level ${actual.level} "${actual.normalizedText}"`;
}

function checkHeadingSequence(templateHeadings, candidateHeadings, violations) {
  const maxLen = Math.max(templateHeadings.length, candidateHeadings.length);
  for (let i = 0; i < maxLen; i++) {
    const expected = templateHeadings[i];
    const actual = candidateHeadings[i];
    const mismatch =
      !expected ||
      !actual ||
      expected.level !== actual.level ||
      expected.normalizedText !== actual.normalizedText;
    if (mismatch) {
      violations.push({
        rule: 'R4',
        headingOrdinal: i,
        detail: describeHeadingMismatch(expected, actual, i),
      });
    }
  }
}

function checkSectionContent(templateHeadings, candidateHeadings, body, violations) {
  if (templateHeadings.length === 0) {
    const visible = wholeDocumentVisibleContent(body);
    if (visible.length === 0) {
      violations.push({
        rule: 'R6',
        headingOrdinal: 0,
        detail: 'heading-free candidate has no visible content',
      });
    }
  }
  for (const heading of candidateHeadings) {
    const visible = sectionVisibleContent(body, heading);
    if (visible.length === 0) {
      violations.push({
        rule: 'R5',
        headingOrdinal: heading.ordinal,
        detail: `section "${heading.text}" has no visible content`,
      });
    }
  }
}

function checkGlobalEvidenceRefs(safeCandidate, ledgerRefIdSet, qualityGateIdSet, violations) {
  const refs = Array.isArray(safeCandidate.evidence_refs) ? safeCandidate.evidence_refs : [];
  for (const ref of refs) {
    if (!ledgerRefIdSet.has(ref) && !qualityGateIdSet.has(ref)) {
      violations.push({
        rule: 'R8',
        headingOrdinal: null,
        detail: `unresolved global evidence reference: ${ref}`,
      });
    }
  }
}

function sectionRefsOf(section) {
  return section && Array.isArray(section.evidence_refs) ? section.evidence_refs : [];
}

function buildSectionEvidenceMap(safeCandidate, ledgerRefIdSet, qualityGateIdSet, violations) {
  const sectionEvidence = Array.isArray(safeCandidate.section_evidence)
    ? safeCandidate.section_evidence
    : [];
  const byOrdinal = new Map();
  for (const section of sectionEvidence) {
    const ordinal = section && typeof section === 'object' ? section.heading_ordinal : null;
    const refs = sectionRefsOf(section);
    byOrdinal.set(ordinal, refs);
    for (const ref of refs) {
      if (!ledgerRefIdSet.has(ref) && !qualityGateIdSet.has(ref)) {
        violations.push({
          rule: 'R8',
          headingOrdinal: ordinal,
          detail: `unresolved section evidence reference: ${ref}`,
        });
      }
    }
  }
  return byOrdinal;
}

function checkTestingSections(
  candidateHeadings,
  sectionEvidenceByOrdinal,
  qualityGateIdSet,
  violations
) {
  for (const heading of candidateHeadings) {
    if (!TESTING_HEADING_RE.test(heading.normalizedText)) continue;
    const refs = sectionEvidenceByOrdinal.has(heading.ordinal)
      ? sectionEvidenceByOrdinal.get(heading.ordinal)
      : [];
    const hasQualityGateRef = refs.some((ref) => qualityGateIdSet.has(ref));
    if (!hasQualityGateRef) {
      violations.push({
        rule: 'R9',
        headingOrdinal: heading.ordinal,
        detail: `section "${heading.text}" requires at least one quality-gate evidence reference`,
      });
    }
  }
}

function checkEntryFacts(entry, ref, ordinal, sectionText, violations) {
  if (
    typeof entry.command === 'string' &&
    entry.command !== '' &&
    !sectionText.includes(entry.command)
  ) {
    violations.push({
      rule: 'R10',
      headingOrdinal: ordinal,
      detail: `section is missing exact command from evidence ${ref}: ${entry.command}`,
    });
  }
  for (const token of outcomeTokens(entry)) {
    if (!sectionText.includes(token)) {
      violations.push({
        rule: 'R10',
        headingOrdinal: ordinal,
        detail: `section is missing outcome token "${token}" from evidence ${ref}`,
      });
    }
  }
}

function checkEvidenceFacts(context, violations) {
  const { candidateHeadings, sectionEvidenceByOrdinal, entriesById, body } = context;
  for (const [ordinal, refs] of sectionEvidenceByOrdinal.entries()) {
    const heading = candidateHeadings.find((h) => h.ordinal === ordinal);
    if (!heading) continue;
    const sectionText = sectionVisibleContent(body, heading);
    for (const ref of refs) {
      const entry = entriesById.get(ref);
      if (!entry) continue;
      checkEntryFacts(entry, ref, ordinal, sectionText, violations);
    }
  }
}

/**
 * @param {{candidate:object, template:string, templateSha256:string, evidenceCatalog:*, qualityGateIds:Iterable, ledgerRefIds:Iterable}} params
 * @returns {{valid:boolean, violations:Array<{rule:string, headingOrdinal:(number|null), detail:string}>}}
 */
function validatePrBodyCandidate({
  candidate,
  template,
  templateSha256,
  evidenceCatalog,
  qualityGateIds,
  ledgerRefIds,
}) {
  const violations = [];
  const safeCandidate = candidate && typeof candidate === 'object' ? candidate : {};
  const entries = normalizeEvidenceEntries(evidenceCatalog);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const qualityGateIdSet = toIdSet(qualityGateIds);
  const ledgerRefIdSet = toIdSet(ledgerRefIds);

  checkDigest(safeCandidate, templateSha256, violations);

  const rawBody = safeCandidate.body;
  const body = canonicalizeBody(typeof rawBody === 'string' ? rawBody : '');
  checkBodyShape(rawBody, body, violations);
  checkIssueTokens(body, violations);

  const templateHeadings = extractHeadings(template);
  const candidateHeadings = extractHeadings(body);
  checkHeadingSequence(templateHeadings, candidateHeadings, violations);
  checkSectionContent(templateHeadings, candidateHeadings, body, violations);

  checkGlobalEvidenceRefs(safeCandidate, ledgerRefIdSet, qualityGateIdSet, violations);
  const sectionEvidenceByOrdinal = buildSectionEvidenceMap(
    safeCandidate,
    ledgerRefIdSet,
    qualityGateIdSet,
    violations
  );
  checkTestingSections(candidateHeadings, sectionEvidenceByOrdinal, qualityGateIdSet, violations);
  checkEvidenceFacts(
    { candidateHeadings, sectionEvidenceByOrdinal, entriesById, body },
    violations
  );

  return { valid: violations.length === 0, violations };
}

module.exports = {
  RULES,
  KNOWN_ISSUE_TOKENS,
  canonicalizeBody,
  hashBody,
  validatePrBodyCandidate,
};
