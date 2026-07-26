const assert = require('assert');
const {
  collectConfiguredProviders,
  formatRoutingSummary,
  normalizeProviderByRole,
  resolveAgentProvider,
  resolveDefaultProvider,
  validateProviderByRole,
} = require('../src/provider-routing');
const { getProvider } = require('../src/providers');

describe('Provider routing resolver', function () {
  const RESOLUTION_CASES = [
    {
      name: 'forceProvider overrides everything',
      agent: { role: 'validator', provider: 'codex' },
      clusterConfig: {
        forceProvider: 'gemini',
        providerByRole: { validator: 'opencode' },
        defaultProvider: 'claude',
      },
      settings: { providerByRole: { validator: 'pi' }, defaultProvider: 'codex' },
      expected: { provider: 'gemini', source: 'cluster.forceProvider' },
    },
    {
      name: 'explicit agent provider overrides role mappings',
      agent: { role: 'validator', provider: 'codex' },
      clusterConfig: { providerByRole: { validator: 'gemini' }, defaultProvider: 'claude' },
      settings: { providerByRole: { validator: 'pi' } },
      expected: { provider: 'codex', source: 'agent.provider' },
    },
    {
      name: 'cluster role mapping overrides settings role mapping',
      agent: { role: 'planning' },
      clusterConfig: { providerByRole: { planning: 'codex' } },
      settings: { providerByRole: { planning: 'gemini' }, defaultProvider: 'claude' },
      expected: { provider: 'codex', source: 'cluster.providerByRole' },
    },
    {
      name: 'settings role mapping overrides generic defaults',
      agent: { role: 'validator' },
      clusterConfig: { defaultProvider: 'claude' },
      settings: { providerByRole: { validator: 'gemini' }, defaultProvider: 'codex' },
      expected: { provider: 'gemini', source: 'settings.providerByRole' },
    },
    {
      name: 'cluster default overrides settings default when no role mapping applies',
      agent: { role: 'implementation' },
      clusterConfig: { defaultProvider: 'codex' },
      settings: { defaultProvider: 'gemini' },
      expected: { provider: 'codex', source: 'cluster.defaultProvider' },
    },
    {
      name: 'settings default applies when cluster has none',
      agent: { role: 'implementation' },
      clusterConfig: {},
      settings: { defaultProvider: 'gemini' },
      expected: { provider: 'gemini', source: 'settings.defaultProvider' },
    },
    {
      name: 'falls back to claude with no configuration at all',
      agent: { role: 'implementation' },
      clusterConfig: {},
      settings: {},
      expected: { provider: 'claude', source: 'fallback' },
    },
    {
      name: 'unmapped role falls back without error',
      agent: { role: 'completion-detector' },
      clusterConfig: { providerByRole: { planning: 'codex' }, defaultProvider: 'claude' },
      settings: {},
      expected: { provider: 'claude', source: 'cluster.defaultProvider' },
    },
    {
      name: 'agent without a role skips role mappings entirely',
      agent: {},
      clusterConfig: { providerByRole: { planning: 'codex' }, defaultProvider: 'claude' },
      settings: {},
      expected: { provider: 'claude', source: 'cluster.defaultProvider' },
    },
    {
      name: 'custom role names route like built-in roles',
      agent: { role: 'security-auditor' },
      clusterConfig: {
        providerByRole: { 'security-auditor': 'gemini' },
        defaultProvider: 'claude',
      },
      settings: {},
      expected: { provider: 'gemini', source: 'cluster.providerByRole' },
    },
    {
      name: 'aliases in a role mapping normalize to canonical ids',
      agent: { role: 'planning' },
      clusterConfig: { providerByRole: { planning: 'anthropic' }, defaultProvider: 'codex' },
      settings: {},
      expected: { provider: 'claude', source: 'cluster.providerByRole' },
    },
    {
      name: 'aliases in settings role mapping normalize to canonical ids',
      agent: { role: 'planning' },
      clusterConfig: {},
      settings: { providerByRole: { planning: 'openai' }, defaultProvider: 'claude' },
      expected: { provider: 'codex', source: 'settings.providerByRole' },
    },
  ];

  for (const testCase of RESOLUTION_CASES) {
    it(testCase.name, function () {
      const result = resolveAgentProvider({
        agent: testCase.agent,
        clusterConfig: testCase.clusterConfig,
        settings: testCase.settings,
      });
      assert.strictEqual(result.provider, testCase.expected.provider);
      assert.strictEqual(result.source, testCase.expected.source);
      assert.strictEqual(result.role, testCase.agent.role || null);
    });
  }

  it('resolves with no arguments at all', function () {
    assert.deepStrictEqual(resolveAgentProvider(), {
      provider: 'claude',
      source: 'fallback',
      role: null,
    });
  });

  it('resolveDefaultProvider ignores role mappings', function () {
    const provider = resolveDefaultProvider({
      clusterConfig: { providerByRole: { validator: 'gemini' }, defaultProvider: 'codex' },
      settings: { defaultProvider: 'claude' },
    });
    assert.strictEqual(provider, 'codex');
  });
});

describe('normalizeProviderByRole', function () {
  it('returns an empty object for non-object input', function () {
    for (const value of [null, undefined, [], 42, 'codex', true]) {
      assert.deepStrictEqual(normalizeProviderByRole(value), {});
    }
  });

  it('normalizes aliases to canonical provider ids', function () {
    assert.deepStrictEqual(
      normalizeProviderByRole({ planning: 'anthropic', validator: 'openai' }),
      {
        planning: 'claude',
        validator: 'codex',
      }
    );
  });

  it('drops empty and non-string entries', function () {
    assert.deepStrictEqual(
      normalizeProviderByRole({ planning: '', validator: null, worker: 42, ok: 'gemini' }),
      { ok: 'gemini' }
    );
  });

  it('trims surrounding whitespace on provider values', function () {
    assert.deepStrictEqual(normalizeProviderByRole({ validator: '  gemini  ' }), {
      validator: 'gemini',
    });
  });
});

describe('validateProviderByRole', function () {
  it('accepts undefined, null and an empty map', function () {
    assert.deepStrictEqual(validateProviderByRole(undefined), []);
    assert.deepStrictEqual(validateProviderByRole(null), []);
    assert.deepStrictEqual(validateProviderByRole({}), []);
  });

  it('accepts a valid mixed-provider map including aliases', function () {
    assert.deepStrictEqual(
      validateProviderByRole({
        planning: 'codex',
        implementation: 'anthropic',
        validator: 'gemini',
      }),
      []
    );
  });

  it('rejects non-object values', function () {
    const errors = validateProviderByRole(['codex']);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /must be an object mapping agent roles/);
  });

  it('names the role, the bad value and the valid providers', function () {
    const errors = validateProviderByRole({ validator: 'foo' });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /providerByRole\.validator/);
    assert.match(errors[0], /unknown provider "foo"/);
    assert.match(errors[0], /Choose one of: .*claude/);
  });

  it('rejects empty role keys', function () {
    const errors = validateProviderByRole({ '': 'codex' });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /empty role key/);
  });

  it('rejects empty and non-string provider values', function () {
    const errors = validateProviderByRole({ validator: '', planning: 7 });
    assert.strictEqual(errors.length, 2);
    for (const error of errors) {
      assert.match(error, /must be a non-empty provider name/);
    }
  });

  it('uses the supplied label in messages', function () {
    const errors = validateProviderByRole({ validator: 'nope' }, 'settings.providerByRole');
    assert.match(errors[0], /^settings\.providerByRole\.validator/);
  });
});

describe('collectConfiguredProviders', function () {
  it('returns a single wildcard entry under forceProvider', function () {
    const entries = collectConfiguredProviders({
      config: {
        forceProvider: 'codex',
        providerByRole: { validator: 'gemini' },
        agents: [{ id: 'v', role: 'validator', provider: 'claude' }],
      },
      settings: { providerByRole: { planning: 'pi' } },
    });
    assert.deepStrictEqual(entries, [{ provider: 'codex', roles: ['*'] }]);
  });

  it('dedupes providers and attaches every requiring role', function () {
    const entries = collectConfiguredProviders({
      config: {
        defaultProvider: 'claude',
        providerByRole: { planning: 'codex', validator: 'gemini' },
        agents: [
          { id: 'planner', role: 'planning' },
          { id: 'worker', role: 'implementation' },
          { id: 'validator-a', role: 'validator' },
          { id: 'validator-b', role: 'validator' },
        ],
      },
      settings: {},
    });

    assert.deepStrictEqual(entries, [
      { provider: 'claude', roles: ['default', 'implementation'] },
      { provider: 'codex', roles: ['planning'] },
      { provider: 'gemini', roles: ['validator'] },
    ]);
  });

  it('includes settings role mappings for roles the cluster does not override', function () {
    const entries = collectConfiguredProviders({
      config: { defaultProvider: 'claude', providerByRole: { validator: 'gemini' } },
      settings: { providerByRole: { validator: 'pi', planning: 'codex' } },
    });
    const providers = entries.map((entry) => entry.provider);
    assert.deepStrictEqual(providers, ['claude', 'codex', 'gemini']);
    assert.ok(!providers.includes('pi'), 'cluster mapping must beat the settings mapping');
  });

  it('includes providers named only by explicit agent overrides', function () {
    const entries = collectConfiguredProviders({
      config: {
        defaultProvider: 'claude',
        agents: [{ id: 'special', role: 'implementation', provider: 'opencode' }],
      },
      settings: {},
    });
    assert.deepStrictEqual(entries, [
      { provider: 'claude', roles: ['default'] },
      { provider: 'opencode', roles: ['implementation'] },
    ]);
  });

  it('labels roleless agents by id', function () {
    const entries = collectConfiguredProviders({
      config: { defaultProvider: 'claude', agents: [{ id: 'lonely', provider: 'gemini' }] },
      settings: {},
    });
    assert.deepStrictEqual(entries, [
      { provider: 'claude', roles: ['default'] },
      { provider: 'gemini', roles: ['lonely'] },
    ]);
  });

  it('returns just the default for a config with no routing at all', function () {
    const entries = collectConfiguredProviders({
      config: { agents: [{ id: 'worker', role: 'implementation' }] },
      settings: { defaultProvider: 'claude' },
    });
    assert.deepStrictEqual(entries, [{ provider: 'claude', roles: ['default', 'implementation'] }]);
  });

  it('survives a config with no agents array', function () {
    const entries = collectConfiguredProviders({ config: {}, settings: {} });
    assert.deepStrictEqual(entries, [{ provider: 'claude', roles: ['default'] }]);
  });
});

describe('formatRoutingSummary', function () {
  it('lists each role once plus the default', function () {
    const summary = formatRoutingSummary(
      [
        { role: 'planning', provider: 'codex' },
        { role: 'implementation', provider: 'claude' },
        { role: 'validator', provider: 'gemini' },
        { role: 'validator', provider: 'gemini' },
      ],
      'claude'
    );
    assert.strictEqual(
      summary,
      'Provider routing: planning=codex, implementation=claude, validator=gemini, default=claude'
    );
  });

  it('handles an empty route list', function () {
    assert.strictEqual(formatRoutingSummary([], 'codex'), 'Provider routing: default=codex');
  });
});

describe('Provider routing model resolution', function () {
  it('resolves different models for the same level under different role providers', function () {
    const settings = {
      providerByRole: { planning: 'codex', implementation: 'claude' },
      providerSettings: {},
    };
    const clusterConfig = { defaultProvider: 'claude' };

    const planningProvider = resolveAgentProvider({
      agent: { id: 'planner', role: 'planning' },
      clusterConfig,
      settings,
    }).provider;
    const workerProvider = resolveAgentProvider({
      agent: { id: 'worker', role: 'implementation' },
      clusterConfig,
      settings,
    }).provider;

    assert.strictEqual(planningProvider, 'codex');
    assert.strictEqual(workerProvider, 'claude');

    const planningSpec = getProvider(planningProvider).resolveModelSpec('level2', {});
    const workerSpec = getProvider(workerProvider).resolveModelSpec('level2', {});

    assert.ok(planningSpec.model, 'codex must resolve a model for level2');
    assert.ok(workerSpec.model, 'claude must resolve a model for level2');
    assert.notStrictEqual(
      planningSpec.model,
      workerSpec.model,
      'level2 must map through each provider its own model'
    );
  });
});
