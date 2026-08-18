const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PR_BODY_TEMPLATE_ERRORS,
  admitPrBodyTemplateFile,
} = require('../src/pr-body-template-file');

function mkTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-pr-body-template-'));
  fs.mkdirSync(path.join(repoRoot, '.github'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.github', 'pull_request_template.md'),
    '## Problem\ntext\n'
  );
  return repoRoot;
}

describe('admitPrBodyTemplateFile', function () {
  let repoRoot;

  beforeEach(function () {
    repoRoot = mkTempRepo();
  });

  afterEach(function () {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('accepts a repository-relative path', function () {
    const snapshot = admitPrBodyTemplateFile({
      pathInput: '.github/pull_request_template.md',
      repoRoot,
    });
    assert.equal(snapshot.sourcePath, '.github/pull_request_template.md');
    assert.equal(snapshot.content, '## Problem\ntext\n');
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  });

  it('accepts a contained absolute path with an identical digest to the relative form', function () {
    const relativeSnapshot = admitPrBodyTemplateFile({
      pathInput: '.github/pull_request_template.md',
      repoRoot,
    });
    const absoluteSnapshot = admitPrBodyTemplateFile({
      pathInput: path.join(repoRoot, '.github', 'pull_request_template.md'),
      repoRoot,
    });
    assert.equal(absoluteSnapshot.sha256, relativeSnapshot.sha256);
    assert.equal(absoluteSnapshot.sourcePath, relativeSnapshot.sourcePath);
  });

  it('rejects traversal outside the repository', function () {
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: '../outside.md', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.OUTSIDE_REPOSITORY
    );
  });

  it('rejects a symlink that escapes the repository', function () {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 'secret');
    const linkPath = path.join(repoRoot, 'escape.md');
    fs.symlinkSync(outsideFile, linkPath);
    try {
      assert.throws(
        () => admitPrBodyTemplateFile({ pathInput: 'escape.md', repoRoot }),
        (error) => error.code === PR_BODY_TEMPLATE_ERRORS.OUTSIDE_REPOSITORY
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a missing file', function () {
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: 'does/not/exist.md', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.NOT_FOUND
    );
  });

  it('rejects a directory', function () {
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: '.github', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.NOT_REGULAR_FILE
    );
  });

  it('rejects invalid UTF-8', function () {
    const badPath = path.join(repoRoot, 'bad-utf8.md');
    fs.writeFileSync(badPath, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: 'bad-utf8.md', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.INVALID_UTF8
    );
  });

  it('rejects a NUL byte', function () {
    const nulPath = path.join(repoRoot, 'nul.md');
    fs.writeFileSync(nulPath, 'hello\0world');
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: 'nul.md', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.CONTAINS_NUL
    );
  });

  it('rejects content over 65536 characters', function () {
    const bigPath = path.join(repoRoot, 'big.md');
    fs.writeFileSync(bigPath, 'x'.repeat(65537));
    assert.throws(
      () => admitPrBodyTemplateFile({ pathInput: 'big.md', repoRoot }),
      (error) => error.code === PR_BODY_TEMPLATE_ERRORS.TOO_LARGE
    );
  });

  it('produces byte-identical snapshots for foreground and simulated-daemon admission', function () {
    const first = admitPrBodyTemplateFile({
      pathInput: '.github/pull_request_template.md',
      repoRoot,
    });
    // Simulated daemon admission: same inputs, independent call, no shared state.
    const second = admitPrBodyTemplateFile({
      pathInput: '.github/pull_request_template.md',
      repoRoot,
    });
    assert.deepEqual(first, second);
  });
});
