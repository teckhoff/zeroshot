const assert = require('assert');
const path = require('path');

const { runClusterPreflight, resolvePrBodyOptionsOrThrow } = require('../../cli/index');

describe('runClusterPreflight effective plan', function () {
  async function capture(options, settings) {
    let received;
    await runClusterPreflight({
      input: { text: 'task' },
      options,
      settings,
      providerOverride: 'claude',
      forceProvider: null,
      deps: {
        requirePreflight: (value) => {
          received = value;
        },
      },
    });
    return received;
  }

  it('derives Docker, worktree, PR, and local gates from the effective plan', async function () {
    const docker = await capture({}, { defaultIsolation: 'docker' });
    assert.strictEqual(docker.requireDocker, true);
    assert.strictEqual(docker.requireGit, false);
    assert.strictEqual(docker.autoPr, false);

    const worktree = await capture({}, { defaultIsolation: 'worktree' });
    assert.strictEqual(worktree.requireDocker, false);
    assert.strictEqual(worktree.requireGit, true);
    assert.strictEqual(worktree.autoPr, false);

    const pr = await capture({}, { defaultDelivery: 'pr' });
    assert.strictEqual(pr.requireDocker, false);
    assert.strictEqual(pr.requireGit, true);
    assert.strictEqual(pr.autoPr, true);

    const local = await capture(
      { noIsolation: true },
      { defaultIsolation: 'worktree', defaultDelivery: 'none' }
    );
    assert.strictEqual(local.requireDocker, false);
    assert.strictEqual(local.requireGit, false);
    assert.strictEqual(local.autoPr, false);
  });

  it('passes the resolved settings into preflight validation', async function () {
    const settings = { defaultIsolation: 'worktree' };
    const received = await capture({}, settings);
    assert.strictEqual(received.settings, settings);
  });
});

describe('resolvePrBodyOptionsOrThrow (--pr-body-template-file admission)', function () {
  const FIXTURE_REPO_ROOT = path.join(__dirname, '..', '..');
  const FIXTURE_RELATIVE_PATH = path.join(
    'tests',
    'fixtures',
    'pr-body-templates',
    'heading-free.md'
  );
  const FIXTURE_ABSOLUTE_PATH = path.join(FIXTURE_REPO_ROOT, FIXTURE_RELATIVE_PATH);

  const previousDaemon = process.env.ZEROSHOT_DAEMON;
  const previousCwd = process.cwd();

  beforeEach(function () {
    process.chdir(FIXTURE_REPO_ROOT);
  });

  afterEach(function () {
    process.chdir(previousCwd);
    if (previousDaemon === undefined) delete process.env.ZEROSHOT_DAEMON;
    else process.env.ZEROSHOT_DAEMON = previousDaemon;
  });

  it('is a no-op when --pr-body-template-file is not set', function () {
    const options = { ship: true };
    resolvePrBodyOptionsOrThrow(options, {
      delivery: 'ship',
      isolation: 'worktree',
      autoMerge: true,
    });
    assert.deepStrictEqual(options, { ship: true });
  });

  it('rejects the option without --pr or --ship (PR_BODY_TEMPLATE_REQUIRES_DELIVERY)', function () {
    const options = { prBodyTemplateFile: FIXTURE_ABSOLUTE_PATH };
    assert.throws(
      () =>
        resolvePrBodyOptionsOrThrow(options, {
          delivery: 'none',
          isolation: 'none',
          autoMerge: false,
        }),
      (error) => error.code === 'PR_BODY_TEMPLATE_REQUIRES_DELIVERY'
    );
  });

  it('rejects combining --pr-body with --pr-body-template-file (PR_BODY_OPTIONS_CONFLICT)', function () {
    const options = { prBodyTemplateFile: FIXTURE_ABSOLUTE_PATH, prBody: 'literal body' };
    assert.throws(
      () =>
        resolvePrBodyOptionsOrThrow(options, {
          delivery: 'pr',
          isolation: 'worktree',
          autoMerge: false,
        }),
      (error) => error.code === 'PR_BODY_OPTIONS_CONFLICT'
    );
  });

  it('admits a valid template for --pr, setting prBodyMode and the full snapshot', function () {
    const options = { prBodyTemplateFile: FIXTURE_RELATIVE_PATH, pr: true };
    resolvePrBodyOptionsOrThrow(options, {
      delivery: 'pr',
      isolation: 'worktree',
      autoMerge: false,
    });

    assert.strictEqual(options.prBodyMode, 'template-file');
    assert.ok(options.prBodyTemplate);
    assert.strictEqual(
      options.prBodyTemplate.sourcePath,
      FIXTURE_RELATIVE_PATH.split(path.sep).join('/')
    );
    assert.match(options.prBodyTemplate.sha256, /^[0-9a-f]{64}$/);
    assert.ok(options.prBodyTemplate.content.length > 0);
  });

  it('admits a valid template for --ship the same way as --pr', function () {
    const options = { prBodyTemplateFile: FIXTURE_RELATIVE_PATH, ship: true };
    resolvePrBodyOptionsOrThrow(options, {
      delivery: 'ship',
      isolation: 'worktree',
      autoMerge: true,
    });

    assert.strictEqual(options.prBodyMode, 'template-file');
    assert.ok(options.prBodyTemplate);
  });

  it('rejects a missing template file with a code and remediation', function () {
    const options = { prBodyTemplateFile: 'does/not/exist.md' };
    assert.throws(
      () =>
        resolvePrBodyOptionsOrThrow(options, {
          delivery: 'pr',
          isolation: 'worktree',
          autoMerge: false,
        }),
      (error) =>
        error.code === 'PR_BODY_TEMPLATE_NOT_FOUND' && typeof error.remediation === 'string'
    );
  });

  it('daemon mode consumes the forwarded snapshot and never rereads the source file', function () {
    process.env.ZEROSHOT_DAEMON = '1';
    const forwardedSnapshot = { sourcePath: 'x.md', content: '# X\n', sha256: 'a'.repeat(64) };
    const options = {
      prBodyTemplateFile: 'does/not/exist/on/this/host.md',
      prBodyTemplate: forwardedSnapshot,
    };

    resolvePrBodyOptionsOrThrow(options, {
      delivery: 'pr',
      isolation: 'worktree',
      autoMerge: false,
    });

    assert.strictEqual(options.prBodyMode, 'template-file');
    assert.strictEqual(options.prBodyTemplate, forwardedSnapshot);
  });

  it('daemon mode throws a clear error when no snapshot was forwarded', function () {
    process.env.ZEROSHOT_DAEMON = '1';
    const options = { prBodyTemplateFile: FIXTURE_RELATIVE_PATH };
    assert.throws(
      () =>
        resolvePrBodyOptionsOrThrow(options, {
          delivery: 'pr',
          isolation: 'worktree',
          autoMerge: false,
        }),
      /missing the forwarded --pr-body-template-file snapshot/
    );
  });
});
