/**
 * Provider routing - the SINGLE source of truth for "which provider does this agent use?"
 *
 * Precedence (highest wins):
 *   1. cluster.forceProvider          (--provider: forces every agent)
 *   2. agent.provider                 (explicit per-agent exception)
 *   3. cluster.providerByRole[role]   (cluster role policy)
 *   4. settings.providerByRole[role]  (global role policy)
 *   5. cluster.defaultProvider
 *   6. settings.defaultProvider
 *   7. 'claude'
 *
 * This module is pure: it takes settings as an argument and never reads disk,
 * so it can be required from lib/settings.js without a require cycle.
 */

const { normalizeProviderName, VALID_PROVIDERS } = require('../lib/provider-names');

const FALLBACK_PROVIDER = 'claude';
const DEFAULT_ROLE_LABEL = 'default';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize a role->provider map: drop non-string/empty entries, canonicalize aliases.
 * @param {any} value
 * @returns {Record<string, string>} Always a plain object (empty when input is unusable)
 */
function normalizeProviderByRole(value) {
  if (!isPlainObject(value)) return {};

  const normalized = {};
  for (const [role, provider] of Object.entries(value)) {
    if (typeof role !== 'string' || !role.trim()) continue;
    if (typeof provider !== 'string' || !provider.trim()) continue;
    normalized[role] = normalizeProviderName(provider.trim()) || provider.trim();
  }
  return normalized;
}

/**
 * Validate a role->provider map.
 * @param {any} value
 * @param {string} [label] - Field path used in error messages
 * @returns {string[]} Error messages (empty when valid)
 */
function validateProviderByRole(value, label = 'providerByRole') {
  if (value === undefined || value === null) return [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object mapping agent roles to provider names`];
  }

  const errors = [];
  for (const [role, provider] of Object.entries(value)) {
    if (typeof role !== 'string' || !role.trim()) {
      errors.push(`${label} contains an empty role key. Keys must be non-empty agent roles.`);
      continue;
    }
    if (typeof provider !== 'string' || !provider.trim()) {
      errors.push(
        `${label}.${role} must be a non-empty provider name. ` +
          `Choose one of: ${VALID_PROVIDERS.join(', ')}`
      );
      continue;
    }
    const normalized = normalizeProviderName(provider.trim());
    if (!VALID_PROVIDERS.includes(normalized)) {
      errors.push(
        `${label}.${role} references unknown provider "${provider}". ` +
          `Choose one of: ${VALID_PROVIDERS.join(', ')}`
      );
    }
  }
  return errors;
}

function canonical(provider) {
  return normalizeProviderName(provider) || FALLBACK_PROVIDER;
}

/**
 * Resolve the effective provider for one agent.
 * @param {Object} params
 * @param {Object} [params.agent] - Agent config; uses `.provider` and `.role`
 * @param {Object} [params.clusterConfig] - Cluster config
 * @param {Object} [params.settings] - Loaded global settings
 * @returns {{provider: string, source: string, role: string|null}}
 */
function resolveAgentProvider({ agent = {}, clusterConfig = {}, settings = {} } = {}) {
  const role = typeof agent.role === 'string' && agent.role ? agent.role : null;

  if (clusterConfig.forceProvider) {
    return {
      provider: canonical(clusterConfig.forceProvider),
      source: 'cluster.forceProvider',
      role,
    };
  }
  if (agent.provider) {
    return { provider: canonical(agent.provider), source: 'agent.provider', role };
  }
  if (role) {
    const clusterMap = normalizeProviderByRole(clusterConfig.providerByRole);
    if (clusterMap[role]) {
      return { provider: canonical(clusterMap[role]), source: 'cluster.providerByRole', role };
    }
    const settingsMap = normalizeProviderByRole(settings.providerByRole);
    if (settingsMap[role]) {
      return { provider: canonical(settingsMap[role]), source: 'settings.providerByRole', role };
    }
  }
  if (clusterConfig.defaultProvider) {
    return {
      provider: canonical(clusterConfig.defaultProvider),
      source: 'cluster.defaultProvider',
      role,
    };
  }
  if (settings.defaultProvider) {
    return {
      provider: canonical(settings.defaultProvider),
      source: 'settings.defaultProvider',
      role,
    };
  }
  return { provider: FALLBACK_PROVIDER, source: 'fallback', role };
}

/**
 * Resolve the cluster-wide default provider (no agent role in play).
 * @param {Object} params
 * @param {Object} [params.clusterConfig]
 * @param {Object} [params.settings]
 * @returns {string}
 */
function resolveDefaultProvider({ clusterConfig = {}, settings = {} } = {}) {
  return resolveAgentProvider({ clusterConfig, settings }).provider;
}

/**
 * Collect every provider a cluster may use, with the roles requiring each.
 * Uses the SAME precedence as runtime resolution - validation, preflight and
 * execution must never maintain separate implementations.
 *
 * Conservative by design: providers named in `providerByRole` are included even
 * when no agent with that role exists yet, because conductor templates add
 * agents dynamically after preflight.
 *
 * @param {Object} params
 * @param {Object} [params.config] - Cluster config
 * @param {Object} [params.settings] - Loaded global settings
 * @returns {Array<{provider: string, roles: string[]}>} Sorted by provider id
 */
function collectConfiguredProviders({ config = {}, settings = {} } = {}) {
  if (config.forceProvider) {
    return [{ provider: canonical(config.forceProvider), roles: ['*'] }];
  }

  /** @type {Map<string, Set<string>>} */
  const byProvider = new Map();
  const add = (provider, role) => {
    const key = canonical(provider);
    if (!byProvider.has(key)) byProvider.set(key, new Set());
    byProvider.get(key).add(role);
  };

  for (const agent of Array.isArray(config.agents) ? config.agents : []) {
    if (!agent || typeof agent !== 'object') continue;
    const { provider } = resolveAgentProvider({ agent, clusterConfig: config, settings });
    add(provider, agent.role || agent.id || DEFAULT_ROLE_LABEL);
  }

  const settingsMap = normalizeProviderByRole(settings.providerByRole);
  const clusterMap = normalizeProviderByRole(config.providerByRole);
  for (const [role, provider] of Object.entries(settingsMap)) {
    if (clusterMap[role]) continue; // cluster entry wins
    add(provider, role);
  }
  for (const [role, provider] of Object.entries(clusterMap)) {
    add(provider, role);
  }

  add(resolveDefaultProvider({ clusterConfig: config, settings }), DEFAULT_ROLE_LABEL);

  return [...byProvider.entries()]
    .map(([provider, roles]) => ({ provider, roles: [...roles].sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * One-line routing summary for startup logs. Never includes settings or auth values.
 * @param {Array<{role: string|null, provider: string}>} agentRoutes
 * @param {string} defaultProvider
 * @returns {string}
 */
function formatRoutingSummary(agentRoutes = [], defaultProvider = FALLBACK_PROVIDER) {
  const seen = new Map();
  for (const route of agentRoutes) {
    if (!route || !route.role || !route.provider) continue;
    if (!seen.has(route.role)) seen.set(route.role, route.provider);
  }
  const parts = [...seen.entries()].map(([role, provider]) => `${role}=${provider}`);
  parts.push(`default=${canonical(defaultProvider)}`);
  return `Provider routing: ${parts.join(', ')}`;
}

module.exports = {
  FALLBACK_PROVIDER,
  collectConfiguredProviders,
  formatRoutingSummary,
  normalizeProviderByRole,
  resolveAgentProvider,
  resolveDefaultProvider,
  validateProviderByRole,
};
