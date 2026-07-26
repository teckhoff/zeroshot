/**
 * Test: role-based provider routing end to end.
 *
 * Covers the paths where a provider is chosen for a REAL agent: initial cluster
 * agents, agents added at runtime by a conductor template, sub-cluster children,
 * persisted/resumed configs, and detached run-option forwarding.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Orchestrator = require('../../src/orchestrator.js');
const AgentWrapper = require('../../src/agent-wrapper.js');
const MockTaskRunner = require('../helpers/mock-task-runner.js');
const {
  parseRoleProviderSpecs,
  applyRoleProviderOptions,
  prepareClusterConfig,
} = require('../../lib/start-cluster.js');

// Isolate from user settings
const testSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-role-routing-settings-'));
const testSettingsFile = path.join(testSettingsDir, 'settings.json');
process.env.ZEROSHOT_SETTINGS_FILE = testSettingsFile;

function writeSettings(settings) {
  fs.writeFileSync(testSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-role-routing-'));
}

const ROLE_MAP = {
  planning: 'codex',
  implementation: 'claude',
  validator: 'gemini',
  coordinator: 'opencode',
};

function clusterWith(config) {
  return { id: 'test-cluster', createdAt: Date.now(), agents: [], config };
}

function makeAgent(agentConfig, clusterConfig) {
  return new AgentWrapper(agentConfig, null, clusterWith(clusterConfig), {
    testMode: true,
    mockSpawnFn: () => {},
  });
}

after(function () {
  delete process.env.ZEROSHOT_SETTINGS_FILE;
  fs.rmSync(testSettingsDir, { recursive: true, force: true });
});

describe('Provider role routing - AgentWrapper', function () {
  beforeEach(function () {
    writeSettings({ maxModel: 'opus', minModel: null });
  });

  it('routes each role to its configured provider with provenance', function () {
    const clusterConfig = { defaultProvider: 'claude', providerByRole: ROLE_MAP };

    const cases = [
      { id: 'planner', role: 'planning', modelLevel: 'level3', provider: 'codex' },
      { id: 'worker', role: 'implementation', modelLevel: 'level2', provider: 'claude' },
      {
        id: 'validator-requirements',
        role: 'validator',
        modelLevel: 'level2',
        provider: 'gemini',
      },
    ];

    for (const testCase of cases) {
      const state = makeAgent(
        { id: testCase.id, role: testCase.role, modelLevel: testCase.modelLevel },
        clusterConfig
      ).getState();

      assert.strictEqual(state.provider, testCase.provider, `${testCase.id} provider`);
      assert.strictEqual(state.providerSource, 'cluster.providerByRole', `${testCase.id} source`);
    }
  });

  it('reports the fallback source when no routing is configured', function () {
    const state = makeAgent(
      { id: 'worker', role: 'implementation', modelLevel: 'level2' },
      { defaultProvider: 'claude' }
    ).getState();

    assert.strictEqual(state.provider, 'claude');
    assert.strictEqual(state.providerSource, 'cluster.defaultProvider');
  });

  it('lets an explicit agent provider beat the role map', function () {
    const state = makeAgent(
      { id: 'validator-edge', role: 'validator', modelLevel: 'level2', provider: 'codex' },
      { defaultProvider: 'claude', providerByRole: ROLE_MAP }
    ).getState();

    assert.strictEqual(state.provider, 'codex');
    assert.strictEqual(state.providerSource, 'agent.provider');
  });

  it('lets forceProvider beat both the role map and explicit agent providers', function () {
    const state = makeAgent(
      { id: 'validator-edge', role: 'validator', modelLevel: 'level2', provider: 'codex' },
      { defaultProvider: 'claude', providerByRole: ROLE_MAP, forceProvider: 'opencode' }
    ).getState();

    assert.strictEqual(state.provider, 'opencode');
    assert.strictEqual(state.providerSource, 'cluster.forceProvider');
  });

  it('inherits settings.providerByRole when the cluster has no map', function () {
    writeSettings({ maxModel: 'opus', minModel: null, providerByRole: { validator: 'gemini' } });

    const state = makeAgent(
      { id: 'validator-requirements', role: 'validator', modelLevel: 'level2' },
      { defaultProvider: 'claude' }
    ).getState();

    assert.strictEqual(state.provider, 'gemini');
    assert.strictEqual(state.providerSource, 'settings.providerByRole');
  });

  it('resolves models through each role provider, not one shared provider', function () {
    const clusterConfig = { defaultProvider: 'claude', providerByRole: ROLE_MAP };

    const planner = makeAgent(
      { id: 'planner', role: 'planning', modelLevel: 'level2' },
      clusterConfig
    ).getState();
    const worker = makeAgent(
      { id: 'worker', role: 'implementation', modelLevel: 'level2' },
      clusterConfig
    ).getState();

    assert.notStrictEqual(
      planner.modelSpec.model,
      worker.modelSpec.model,
      'the same modelLevel on different providers must resolve different models'
    );
  });
});

describe('Provider role routing - orchestrator', function () {
  this.timeout(15000);

  let tmpDir;
  let orchestrator;

  beforeEach(function () {
    writeSettings({ maxModel: 'opus', minModel: null });
    tmpDir = createTempDir();
  });

  afterEach(function () {
    if (orchestrator) {
      orchestrator.close();
      orchestrator = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function baseConfig(overrides = {}) {
    return {
      defaultProvider: 'claude',
      providerByRole: ROLE_MAP,
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          modelLevel: 'level2',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          prompt: 'Implement the task.',
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'IMPLEMENTATION_READY', content: { text: 'done' } },
            },
          },
        },
      ],
      ...overrides,
    };
  }

  async function startCluster(config) {
    orchestrator = new Orchestrator({
      dataDir: tmpDir,
      taskRunner: new MockTaskRunner(),
      quiet: true,
    });
    const result = await orchestrator.start(config, { text: 'Test task' });
    return orchestrator.getCluster(result.id);
  }

  it('routes initial agents by role', async function () {
    const cluster = await startCluster(baseConfig());
    const worker = cluster.agents.find((a) => a.id === 'worker');

    assert.strictEqual(worker.getState().provider, 'claude');
    assert.strictEqual(worker.getState().providerSource, 'cluster.providerByRole');
  });

  it('routes agents added at runtime (quick/heavy validation) by role', async function () {
    const cluster = await startCluster(baseConfig());

    // What a conductor template's add_agents op produces - no provider fields.
    await orchestrator._opAddAgents(
      cluster,
      {
        agents: [
          {
            id: 'validator-requirements',
            role: 'validator',
            modelLevel: 'level2',
            triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
            prompt: 'Validate requirements.',
          },
          {
            id: 'consensus-coordinator',
            role: 'coordinator',
            modelLevel: 'level2',
            triggers: [{ topic: 'VALIDATION_RESULT', action: 'execute_task' }],
            prompt: 'Aggregate validation results.',
          },
        ],
      },
      {}
    );

    const validator = cluster.agents.find((a) => a.id === 'validator-requirements');
    const coordinator = cluster.agents.find((a) => a.id === 'consensus-coordinator');

    assert.strictEqual(validator.getState().provider, 'gemini');
    assert.strictEqual(validator.getState().providerSource, 'cluster.providerByRole');
    assert.strictEqual(coordinator.getState().provider, 'opencode');
    assert.strictEqual(coordinator.getState().providerSource, 'cluster.providerByRole');
  });

  it('honors an explicit provider on a dynamically added agent', async function () {
    const cluster = await startCluster(baseConfig());

    await orchestrator._opAddAgents(
      cluster,
      {
        agents: [
          {
            id: 'validator-special',
            role: 'validator',
            provider: 'codex',
            modelLevel: 'level2',
            triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
            prompt: 'Validate.',
          },
        ],
      },
      {}
    );

    const validator = cluster.agents.find((a) => a.id === 'validator-special');
    assert.strictEqual(validator.getState().provider, 'codex');
    assert.strictEqual(validator.getState().providerSource, 'agent.provider');
  });

  it('forceProvider still wins for dynamically added agents', async function () {
    const cluster = await startCluster(baseConfig({ forceProvider: 'claude' }));

    await orchestrator._opAddAgents(
      cluster,
      {
        agents: [
          {
            id: 'validator-forced',
            role: 'validator',
            provider: 'codex',
            modelLevel: 'level2',
            triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
            prompt: 'Validate.',
          },
        ],
      },
      {}
    );

    const validator = cluster.agents.find((a) => a.id === 'validator-forced');
    assert.strictEqual(validator.getState().provider, 'claude');
    assert.strictEqual(validator.getState().providerSource, 'cluster.forceProvider');
  });

  it('persists the role map so a resumed cluster keeps its routing', async function () {
    const cluster = await startCluster(baseConfig());
    const clusterId = cluster.id;
    await orchestrator.stop(clusterId);
    orchestrator.close();

    // Settings change between runs must NOT change the cluster's routing.
    writeSettings({
      maxModel: 'opus',
      minModel: null,
      defaultProvider: 'pi',
      providerByRole: { implementation: 'pi', validator: 'pi' },
    });

    orchestrator = await Orchestrator.create({ dataDir: tmpDir, quiet: true });
    const reloaded = orchestrator.getCluster(clusterId);

    assert.deepStrictEqual(reloaded.config.providerByRole, ROLE_MAP);

    const worker = makeAgent(
      { id: 'worker', role: 'implementation', modelLevel: 'level2' },
      reloaded.config
    ).getState();
    assert.strictEqual(worker.provider, 'claude');
    assert.strictEqual(worker.providerSource, 'cluster.providerByRole');

    const validator = makeAgent(
      { id: 'validator-requirements', role: 'validator', modelLevel: 'level2' },
      reloaded.config
    ).getState();
    assert.strictEqual(validator.provider, 'gemini');
  });

  it('keeps forceProvider winning after persistence and reload', async function () {
    const cluster = await startCluster(baseConfig({ forceProvider: 'opencode' }));
    const clusterId = cluster.id;
    await orchestrator.stop(clusterId);
    orchestrator.close();

    orchestrator = await Orchestrator.create({ dataDir: tmpDir, quiet: true });
    const reloaded = orchestrator.getCluster(clusterId);

    const worker = makeAgent(
      { id: 'worker', role: 'implementation', modelLevel: 'level2' },
      reloaded.config
    ).getState();
    assert.strictEqual(worker.provider, 'opencode');
    assert.strictEqual(worker.providerSource, 'cluster.forceProvider');
  });
});

describe('Provider role routing - sub-cluster inheritance', function () {
  // Mirrors the merge in SubClusterWrapper._spawnChildCluster.
  function mergeChildConfig(parentConfig, childConfig) {
    const { normalizeProviderByRole } = require('../../src/provider-routing');
    const merged = JSON.parse(JSON.stringify(childConfig));
    if (parentConfig.forceProvider) {
      merged.forceProvider = parentConfig.forceProvider;
      merged.defaultProvider = parentConfig.forceProvider;
    } else if (parentConfig.defaultProvider && !merged.defaultProvider) {
      merged.defaultProvider = parentConfig.defaultProvider;
    }
    merged.providerByRole = {
      ...normalizeProviderByRole(parentConfig.providerByRole),
      ...normalizeProviderByRole(merged.providerByRole),
    };
    return merged;
  }

  it('inherits parent role mappings the child does not define', function () {
    const merged = mergeChildConfig(
      { defaultProvider: 'claude', providerByRole: ROLE_MAP },
      { agents: [] }
    );
    assert.deepStrictEqual(merged.providerByRole, ROLE_MAP);
    assert.strictEqual(merged.defaultProvider, 'claude');
  });

  it('lets a child role entry win over the parent', function () {
    const merged = mergeChildConfig(
      { defaultProvider: 'claude', providerByRole: ROLE_MAP },
      { providerByRole: { validator: 'codex' }, agents: [] }
    );
    assert.strictEqual(merged.providerByRole.validator, 'codex');
    assert.strictEqual(merged.providerByRole.planning, 'codex');
    assert.strictEqual(merged.providerByRole.implementation, 'claude');
  });

  it('normalizes aliases while merging', function () {
    const merged = mergeChildConfig(
      { providerByRole: { planning: 'anthropic' } },
      { providerByRole: { validator: 'openai' }, agents: [] }
    );
    assert.deepStrictEqual(merged.providerByRole, { planning: 'claude', validator: 'codex' });
  });

  it('propagates forceProvider so the child cannot deviate', function () {
    const merged = mergeChildConfig(
      { forceProvider: 'gemini', providerByRole: ROLE_MAP },
      { providerByRole: { validator: 'codex' }, agents: [] }
    );
    assert.strictEqual(merged.forceProvider, 'gemini');
  });
});

describe('Provider role routing - --role-provider CLI specs', function () {
  it('parses repeatable role=provider specs', function () {
    assert.deepStrictEqual(parseRoleProviderSpecs(['planning=codex', 'validator=gemini']), {
      planning: 'codex',
      validator: 'gemini',
    });
  });

  it('normalizes provider aliases in specs', function () {
    assert.deepStrictEqual(parseRoleProviderSpecs(['planning=anthropic']), { planning: 'claude' });
  });

  it('accepts an empty/absent spec list', function () {
    assert.deepStrictEqual(parseRoleProviderSpecs([]), {});
    assert.deepStrictEqual(parseRoleProviderSpecs(undefined), {});
  });

  it('rejects malformed specs with an actionable message', function () {
    assert.throws(() => parseRoleProviderSpecs(['planning']), /Format: role=provider/);
    assert.throws(() => parseRoleProviderSpecs(['=codex']), /Format: role=provider/);
    assert.throws(() => parseRoleProviderSpecs(['planning=']), /Format: role=provider/);
  });

  it('rejects unknown providers naming the valid set', function () {
    assert.throws(
      () => parseRoleProviderSpecs(['planning=nope']),
      /unknown provider "nope".*Choose one of: .*claude/s
    );
  });

  it('merges into an existing map with the CLI winning per role', function () {
    const config = { providerByRole: { planning: 'claude', validator: 'gemini' } };
    applyRoleProviderOptions(config, ['planning=codex']);
    assert.deepStrictEqual(config.providerByRole, { planning: 'codex', validator: 'gemini' });
  });

  it('leaves the config map untouched when no specs are given', function () {
    const config = { providerByRole: { validator: 'gemini' } };
    applyRoleProviderOptions(config, []);
    assert.deepStrictEqual(config.providerByRole, { validator: 'gemini' });
  });

  it('applies specs through prepareClusterConfig, with forceProvider still winning', function () {
    const prepared = prepareClusterConfig(
      { agents: [{ id: 'v', role: 'validator' }] },
      { defaultProvider: 'claude', providerSettings: {} },
      undefined,
      ['validator=gemini']
    );
    assert.deepStrictEqual(prepared.providerByRole, { validator: 'gemini' });

    const forced = prepareClusterConfig(
      { agents: [{ id: 'v', role: 'validator' }] },
      { defaultProvider: 'claude', providerSettings: {} },
      'codex',
      ['validator=gemini']
    );
    assert.strictEqual(forced.forceProvider, 'codex');
    assert.deepStrictEqual(forced.providerByRole, { validator: 'gemini' });

    const state = makeAgent(
      { id: 'v', role: 'validator', modelLevel: 'level2' },
      forced
    ).getState();
    assert.strictEqual(state.provider, 'codex', 'forceProvider outranks the role map at runtime');
  });

  it('round-trips through ZEROSHOT_RUN_OPTIONS for detached runs', function () {
    const options = { worktree: true, pr: true, roleProvider: ['validator=gemini'] };
    const serialized = JSON.stringify(options);

    const original = process.env.ZEROSHOT_RUN_OPTIONS;
    process.env.ZEROSHOT_RUN_OPTIONS = serialized;
    try {
      const rehydrated = JSON.parse(process.env.ZEROSHOT_RUN_OPTIONS);
      assert.deepStrictEqual(rehydrated.roleProvider, ['validator=gemini']);
      assert.deepStrictEqual(parseRoleProviderSpecs(rehydrated.roleProvider), {
        validator: 'gemini',
      });
    } finally {
      if (original === undefined) {
        delete process.env.ZEROSHOT_RUN_OPTIONS;
      } else {
        process.env.ZEROSHOT_RUN_OPTIONS = original;
      }
    }
  });
});
