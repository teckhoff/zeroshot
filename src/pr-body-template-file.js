/**
 * Admission-time handling for `--pr-body-template-file`.
 *
 * Reads a repository-owned Markdown template exactly once, validates it, and
 * returns an immutable snapshot. Detached/resumed runs consume the snapshot
 * only -- the source path is diagnostic metadata, never a deferred input.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const {
  createCopyBoundary,
  resolveSourcePath,
  isCopyContainmentError,
} = require('./copy-containment');
const { MAX_PR_BODY_LENGTH } = require('./pr-body-template');

const PR_BODY_TEMPLATE_ERRORS = Object.freeze({
  REQUIRES_DELIVERY: 'PR_BODY_TEMPLATE_REQUIRES_DELIVERY',
  OPTIONS_CONFLICT: 'PR_BODY_OPTIONS_CONFLICT',
  NOT_FOUND: 'PR_BODY_TEMPLATE_NOT_FOUND',
  NOT_REGULAR_FILE: 'PR_BODY_TEMPLATE_NOT_REGULAR_FILE',
  OUTSIDE_REPOSITORY: 'PR_BODY_TEMPLATE_OUTSIDE_REPOSITORY',
  INVALID_UTF8: 'PR_BODY_TEMPLATE_INVALID_UTF8',
  CONTAINS_NUL: 'PR_BODY_TEMPLATE_CONTAINS_NUL',
  TOO_LARGE: 'PR_BODY_TEMPLATE_TOO_LARGE',
});

class PrBodyTemplateError extends Error {
  constructor(code, message, remediation, cause) {
    super(message);
    this.name = 'PrBodyTemplateError';
    this.code = code;
    this.remediation = remediation;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function toPosixRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/**
 * @param {{ pathInput: string, repoRoot: string }} params
 * @returns {{ sourcePath: string, content: string, sha256: string }}
 */
function admitPrBodyTemplateFile({ pathInput, repoRoot }) {
  if (typeof pathInput !== 'string' || pathInput.trim() === '') {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.NOT_FOUND,
      'PR body template path must be a non-empty string.',
      'Pass a repository-relative path, e.g. --pr-body-template-file .github/pull_request_template.md'
    );
  }

  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
  } catch (error) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.NOT_FOUND,
      `Repository root could not be resolved: ${repoRoot}`,
      'Run this command from inside a git repository.',
      error
    );
  }

  const absoluteInput = path.resolve(canonicalRepoRoot, pathInput);
  const relativeToRoot = path.relative(canonicalRepoRoot, absoluteInput);

  if (
    relativeToRoot === '' ||
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.OUTSIDE_REPOSITORY,
      `PR body template path escapes the repository: ${pathInput}`,
      'Use a path that resolves inside the repository root.'
    );
  }

  const boundary = createCopyBoundary(canonicalRepoRoot, canonicalRepoRoot);

  let canonicalTargetPath;
  try {
    canonicalTargetPath = resolveSourcePath(boundary, relativeToRoot);
  } catch (error) {
    if (isCopyContainmentError(error)) {
      throw new PrBodyTemplateError(
        PR_BODY_TEMPLATE_ERRORS.OUTSIDE_REPOSITORY,
        `PR body template path escapes the repository: ${pathInput}`,
        'Use a path that resolves inside the repository root, with no symlink escaping it.'
      );
    }
    if (error && error.code === 'ENOENT') {
      throw new PrBodyTemplateError(
        PR_BODY_TEMPLATE_ERRORS.NOT_FOUND,
        `PR body template file not found: ${pathInput}`,
        'Check the path and try again.'
      );
    }
    throw error;
  }

  let stats;
  try {
    stats = fs.statSync(canonicalTargetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new PrBodyTemplateError(
        PR_BODY_TEMPLATE_ERRORS.NOT_FOUND,
        `PR body template file not found: ${pathInput}`,
        'Check the path and try again.'
      );
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.NOT_REGULAR_FILE,
      `PR body template path is not a regular file: ${pathInput}`,
      'Point --pr-body-template-file at a regular Markdown file, not a directory or special file.'
    );
  }

  const buffer = fs.readFileSync(canonicalTargetPath);

  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.INVALID_UTF8,
      `PR body template is not valid UTF-8: ${pathInput}`,
      'Save the template file as UTF-8 text.',
      error
    );
  }

  if (content.includes('\0')) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.CONTAINS_NUL,
      `PR body template contains a NUL byte: ${pathInput}`,
      'Remove NUL bytes from the template file.'
    );
  }

  if (content.length > MAX_PR_BODY_LENGTH) {
    throw new PrBodyTemplateError(
      PR_BODY_TEMPLATE_ERRORS.TOO_LARGE,
      `PR body template exceeds ${MAX_PR_BODY_LENGTH} characters: ${pathInput}`,
      `Shorten the template file to ${MAX_PR_BODY_LENGTH} characters or fewer.`
    );
  }

  const sourcePath = toPosixRelative(relativeToRoot);
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  return Object.freeze({ sourcePath, content, sha256 });
}

module.exports = {
  PR_BODY_TEMPLATE_ERRORS,
  PrBodyTemplateError,
  admitPrBodyTemplateFile,
};
