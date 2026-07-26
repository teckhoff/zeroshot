const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadSettings, validateSetting, coerceValue, DEFAULT_SETTINGS } = require('../lib/settings');
const {
  validateProviderFeatures,
  validateProviderSettings,
  validateProviderLevel,
} = require('../src/config-validator');
const { getProvider } = require('../src/providers');

describe('Provider settings', function () {
  const testDir = path.join(os.tmpdir(), `zeroshot-provider-settings-${Date.now()}`);
  const settingsFile = path.join(testDir, 'settings.json');

  before(function () {
    fs.mkdirSync(testDir, { recursive: true });
  });

  after(function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('validates defaultProvider values (including legacy aliases)', function () {
    assert.strictEqual(validateSetting('defaultProvider', 'codex'), null);
    assert.strictEqual(validateSetting('defaultProvider', 'openai'), null);
    assert.strictEqual(validateSetting('defaultProvider', 'opencode'), null);
    const error = validateSetting('defaultProvider', 'invalid-provider');
    assert.ok(error);
  });

  it('validates provider level bounds', function () {
    assert.doesNotThrow(() => {
      validateProviderLevel('codex', 'level2', 'level1', 'level3');
    });

    assert.throws(() => {
      validateProviderLevel('codex', 'level4', 'level1', 'level3');
    }, /Invalid level/);
  });

  it('validates provider overrides and reasoning rules', function () {
    assert.doesNotThrow(() => {
      validateProviderSettings('codex', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level1: { model: 'gpt-5.4', reasoningEffort: 'low' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('opencode', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { reasoningEffort: 'high' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('codex', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level3',
        levelOverrides: {
          level3: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('claude', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level3',
        levelOverrides: {
          level3: { model: 'claude-opus-4-8', reasoningEffort: 'max' },
        },
      });
    });

    assert.throws(() => {
      validateProviderSettings('gemini', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { reasoningEffort: 'high' },
        },
      });
    }, /reasoningEffort overrides are only supported/);
  });

  it('validates gateway settings and accepts arbitrary model ids', function () {
    assert.doesNotThrow(() => {
      validateProviderSettings('gateway', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'gateway-key',
        model: 'openrouter/meta-llama/test',
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
        levelOverrides: {
          level2: { model: 'openrouter/meta-llama/test' },
        },
      });
    });

    assert.throws(() => {
      validateProviderSettings('gateway', {
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'gateway-key',
        model: 'test-model',
        toolPolicy: {
          roots: '.',
          commands: ['node'],
        },
      });
    }, /toolPolicy\.roots must be an array of strings/);
  });

  it('accepts max reasoning effort in agent config for Claude and Codex', function () {
    const settings = loadSettings();
    const result = validateProviderFeatures(
      {
        agents: [
          {
            id: 'claude-worker',
            role: 'implementation',
            provider: 'claude',
            model: 'claude-opus-4-8',
            reasoningEffort: 'max',
          },
          {
            id: 'codex-worker',
            role: 'implementation',
            provider: 'codex',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'max',
          },
        ],
      },
      settings
    );

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.warnings, []);
  });

  it('lists max in invalid reasoning-effort diagnostics', function () {
    const result = validateProviderFeatures(
      {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            provider: 'codex',
            reasoningEffort: 'extreme',
          },
        ],
      },
      loadSettings()
    );

    assert.ok(result.warnings.some((warning) => warning.includes('low|medium|high|xhigh|max')));
  });

  it('defaults providerByRole to an empty object', function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    assert.deepStrictEqual(DEFAULT_SETTINGS.providerByRole, {});
  });

  it('validates providerByRole values', function () {
    assert.strictEqual(
      validateSetting('providerByRole', { planning: 'codex', validator: 'gemini' }),
      null
    );
    assert.strictEqual(validateSetting('providerByRole', {}), null);

    const error = validateSetting('providerByRole', { validator: 'not-a-provider' });
    assert.ok(error, 'expected an error for an unknown provider');
    assert.match(error, /providerByRole\.validator/);
    assert.match(error, /unknown provider "not-a-provider"/);
    assert.match(error, /Choose one of: .*gemini/);

    assert.ok(validateSetting('providerByRole', ['codex']));
  });

  it('coerces providerByRole from JSON and normalizes aliases', function () {
    assert.deepStrictEqual(coerceValue('providerByRole', '{"planning":"anthropic"}'), {
      planning: 'claude',
    });
    assert.deepStrictEqual(coerceValue('providerByRole', { validator: 'openai' }), {
      validator: 'codex',
    });
    assert.throws(() => coerceValue('providerByRole', 'not json'), /Invalid JSON for/);
  });

  it('normalizes providerByRole aliases when loading from disk', function () {
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ providerByRole: { planning: 'anthropic', validator: 'gemini' } }, null, 2),
      'utf8'
    );

    const settings = loadSettings();
    assert.deepStrictEqual(settings.providerByRole, { planning: 'claude', validator: 'gemini' });
  });

  it('preserves unrelated roles when one role is updated', function () {
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ providerByRole: { planning: 'codex', validator: 'gemini' } }, null, 2),
      'utf8'
    );

    // What `zeroshot settings set providerByRole.validator opencode` does:
    // load, mutate one role, validate the whole map, save.
    const settings = loadSettings();
    settings.providerByRole.validator = 'opencode';
    assert.strictEqual(validateSetting('providerByRole', settings.providerByRole), null);
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

    assert.deepStrictEqual(loadSettings().providerByRole, {
      planning: 'codex',
      validator: 'opencode',
    });
  });

  it('does not leak providerByRole mutations into the defaults', function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    const settings = loadSettings();
    settings.providerByRole.validator = 'gemini';

    assert.deepStrictEqual(DEFAULT_SETTINGS.providerByRole, {});
    assert.deepStrictEqual(loadSettings().providerByRole, {});
  });

  it('applies legacy maxModel to claude levels', function () {
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    fs.writeFileSync(settingsFile, JSON.stringify({ maxModel: 'haiku' }, null, 2), 'utf8');

    const settings = loadSettings();
    assert.strictEqual(settings.providerSettings.claude.maxLevel, 'level1');
    assert.strictEqual(settings.providerSettings.claude.defaultLevel, 'level1');
  });

  it('uses gpt-5.4 as the default codex model', function () {
    const codex = getProvider('codex');
    const modelSpec = codex.resolveModelSpec(codex.getDefaultLevel(), {});
    assert.strictEqual(modelSpec.model, 'gpt-5.4');
  });

  it('maps claude level3 to opus alias', function () {
    const claude = getProvider('claude');
    const modelSpec = claude.resolveModelSpec('level3', {});
    assert.strictEqual(modelSpec.model, 'opus');
  });

  it('accepts recent canonical Claude model ids', function () {
    const claude = getProvider('claude');
    assert.strictEqual(claude.validateModelId('claude-opus-4-6'), 'claude-opus-4-6');
  });

  it('marks invalid model errors as permanent', function () {
    const claude = getProvider('claude');
    assert.throws(() => {
      try {
        claude.validateModelId('not-a-model');
      } catch (error) {
        assert.strictEqual(error.permanent, true);
        throw error;
      }
    }, /Invalid model "not-a-model"/);
  });

  it('fails before command build when model override is invalid', function () {
    const claude = getProvider('claude');
    assert.throws(() => {
      claude.buildCommand('test context', {
        modelSpec: { model: 'opus-4.6' },
        cliFeatures: { supportsModel: true },
      });
    }, /Invalid model "opus-4.6"/);
  });
});
