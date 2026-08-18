/**
 * PR-Body Author Agent Template
 *
 * Generates the read-only agent that completes a repository-owned PR body
 * template from validated run evidence. It reuses the git-pusher validation
 * consensus trigger so authoring starts only after implementation validators
 * approve, and it never touches the filesystem, Git, or the network.
 */

const { SHARED_TRIGGER_SCRIPT } = require('./git-pusher-trigger-script');

function formatEvidenceEntry(entry) {
  const command = entry.command !== '' ? entry.command : '(no command recorded)';
  const exitCode = entry.exitCode === null ? '(no exit code recorded)' : String(entry.exitCode);
  const completedAt =
    entry.completedAt === null ? '(no timestamp recorded)' : String(entry.completedAt);
  return [
    `- id: ${entry.id}`,
    `  command: ${command}`,
    `  status: ${entry.status}`,
    `  exitCode: ${exitCode}`,
    `  completedAt: ${completedAt}`,
    `  environment: ${entry.environment}`,
    `  outputExcerpt: ${JSON.stringify(entry.outputExcerpt)}`,
  ].join('\n');
}

function formatEvidenceTable(evidenceCatalog) {
  const entries =
    evidenceCatalog && Array.isArray(evidenceCatalog.entries) ? evidenceCatalog.entries : [];
  if (entries.length === 0) return '(no quality-gate evidence recorded for this cycle)';
  return entries.map(formatEvidenceEntry).join('\n');
}

function formatExecutionContext(executionContext) {
  const context = executionContext && typeof executionContext === 'object' ? executionContext : {};
  const platform = context.platform ? context.platform : '(not recorded)';
  const isolationMode = context.isolationMode ? context.isolationMode : '(not recorded)';
  const testEnvironment = context.testEnvironment ? context.testEnvironment : '(not recorded)';
  return `- host platform: ${platform}\n- isolation mode: ${isolationMode}\n- test environment: ${testEnvironment}`;
}

function formatProviderIdentity(providerIdentity) {
  const identity = providerIdentity && typeof providerIdentity === 'object' ? providerIdentity : {};
  const agentId = identity.agentId ? identity.agentId : 'pr-body-author';
  const provider = identity.provider ? identity.provider : '(not recorded)';
  return `- agent id: ${agentId}\n- provider: ${provider}`;
}

function rulesSection() {
  return `## Rules

- Preserve every heading exactly as it appears in the template below: same text, same level, same
  order. Never add, remove, rename, reorder, or re-level a heading.
- Every section must contain visible, concrete content. Replace instructional HTML comments and
  placeholder choices with real answers; you may keep or remove the comments themselves.
- When a section reports a quality-gate check (tests, validation, verification, quality), copy the
  command, status, and exit code EXACTLY as given in the evidence table below. Do not paraphrase or
  alter those facts. You may add explanatory prose around them.
- Describe an evidence entry's environment as "not recorded" when the table says so - never invent
  one.
- Never claim a test, check, or verification ran unless it appears in the evidence table below.
- If issue tokens ({{issue_number}}, {{issue_title}}, {{issue_reference}}) still appear in the
  rendered template, leave them as-is only if no issue metadata was available; otherwise they have
  already been substituted for you.`;
}

function outputSection() {
  return `## Output

Return ONLY the following JSON shape. \`heading_ordinal\` is the zero-based position of the heading
in the template's heading sequence above (0 for a heading-free template).

\`\`\`json
{
  "template_sha256": "<the exact digest provided out-of-band for this template>",
  "body": "<the completed Markdown, full document>",
  "evidence_refs": ["<ledger message id or quality-gate id you relied on globally>"],
  "section_evidence": [
    { "heading_ordinal": 0, "evidence_refs": ["<quality-gate id or ledger message id>"] }
  ]
}
\`\`\`

If you receive deterministic validation feedback on a later turn, fix ONLY the violations listed and
resubmit the full corrected JSON in the same shape.`;
}

function generatePrompt(params) {
  const {
    renderedTemplate,
    taskText,
    issueContext,
    evidenceCatalog,
    repoInstructions,
    executionContext,
    providerIdentity,
  } = params;
  const issueSummary = issueContext
    ? `issue #${issueContext.issueNumber}: ${issueContext.issueTitle}`
    : '(no issue metadata)';
  const repoInstructionsBlock = repoInstructions ? repoInstructions : '(none provided)';

  return `CRITICAL: YOU ARE A READ-ONLY PR-BODY AUTHOR. VALIDATORS ALREADY APPROVED THE IMPLEMENTATION.

Use NO TOOLS. Do NOT read files. Do NOT run shell commands. Do NOT access the network.
Your entire job is to fill in the template below using ONLY the context provided in this prompt,
then return the schema-constrained JSON described at the end.

${rulesSection()}

## Task

${taskText}

## Issue

${issueSummary}

## Template to complete (preserve this exact heading structure)

${renderedTemplate}

## Quality-gate evidence catalog (canonical facts - copy exactly when cited)

${formatEvidenceTable(evidenceCatalog)}

## Execution context

${formatExecutionContext(executionContext)}

## Agent/provider identity (for any required disclosure section)

${formatProviderIdentity(providerIdentity)}

## Repository instructions

${repoInstructionsBlock}

${outputSection()}`;
}

function structuredOutputSchema() {
  return {
    type: 'object',
    properties: {
      template_sha256: {
        type: 'string',
        description: 'Must exactly match the provided template digest.',
      },
      body: { type: 'string' },
      evidence_refs: {
        type: 'array',
        items: { type: 'string' },
      },
      section_evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading_ordinal: { type: 'integer' },
            evidence_refs: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['heading_ordinal', 'evidence_refs'],
        },
      },
    },
    required: ['template_sha256', 'body', 'evidence_refs', 'section_evidence'],
  };
}

/**
 * @param {object} params
 * @param {{sourcePath:string, content:string, sha256:string}} params.template - immutable snapshot
 * @param {string} params.renderedTemplate - template after issue-token substitution
 * @param {string} params.taskText - original task/issue body text
 * @param {{issueNumber:string, issueTitle:string, issueReference:string}|null} params.issueContext
 * @param {{entries:Array<object>}} params.evidenceCatalog
 * @param {string} [params.repoInstructions]
 * @param {object} [params.executionContext]
 * @param {object} [params.providerIdentity]
 * @returns {object} agent configuration
 */
function generatePrBodyAuthorAgent(params) {
  const { template } = params;

  return {
    id: 'pr-body-author',
    role: 'pr-body-author',
    modelLevel: 'level2',
    triggers: [
      {
        topic: 'VALIDATION_RESULT',
        logic: {
          engine: 'javascript',
          script: SHARED_TRIGGER_SCRIPT,
        },
        action: 'execute_task',
      },
      {
        topic: 'PR_BODY_REVISION_REQUESTED',
        action: 'execute_task',
      },
    ],
    prompt: generatePrompt(params),
    hooks: {
      onComplete: {
        action: 'validate_pr_body',
      },
    },
    structuredOutput: structuredOutputSchema(),
    metadata: {
      templateSourcePath: template ? template.sourcePath : null,
      templateSha256: template ? template.sha256 : null,
    },
  };
}

module.exports = {
  generatePrBodyAuthorAgent,
};
