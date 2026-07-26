# Providers

Zeroshot supports two provider shapes:

- CLI-backed providers that shell out to a full agent CLI
- One bundled `gateway` provider that wraps OpenAI-compatible model APIs with a
  Zeroshot-owned tool runner

## Supported Providers

| Provider | CLI         | Install                                                                  |
| -------- | ----------- | ------------------------------------------------------------------------ |
| Claude   | Claude Code | `npm install -g @anthropic-ai/claude-code`                               |
| Codex    | Codex       | `npm install -g @openai/codex`                                           |
| Gateway  | Bundled     | No external CLI required                                                 |
| Gemini   | Gemini      | `npm install -g @google/gemini-cli`                                      |
| Opencode | Opencode    | See https://opencode.ai                                                  |
| Pi       | Pi          | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3` |
| Kiro     | Kiro        | See https://kiro.dev/docs/cli/                                           |
| Copilot  | Copilot     | `npm install -g @github/copilot`                                         |

## Selecting a Provider

- List providers: `zeroshot providers`
- Set default: `zeroshot providers set-default <provider>`
- Configure levels: `zeroshot providers setup <provider>`
- Override per run: `zeroshot run ... --provider <provider>`
- Env override: `ZEROSHOT_PROVIDER=codex`

## Role-Based Provider Routing

One cluster can use a different provider per agent role — for example planning on
Codex, implementation on Claude, and every validator on Gemini. Configure it with
`providerByRole`, a map from agent `role` to provider id.

### Precedence

Highest wins:

1. `forceProvider` (set by `--provider` / `ZEROSHOT_PROVIDER`) — forces every agent
2. `provider` on an individual agent — the per-agent exception
3. `providerByRole[role]` in the cluster config
4. `providerByRole[role]` in global settings
5. `defaultProvider` in the cluster config
6. `defaultProvider` in global settings
7. `claude`

All of this is resolved by one shared module, `src/provider-routing.js`. Runtime
execution, config validation, and preflight use it — they never re-derive the order.

### Cluster config

```json
{
  "defaultProvider": "claude",
  "providerByRole": {
    "planning": "codex",
    "implementation": "claude",
    "validator": "gemini"
  },
  "agents": [
    { "id": "planner", "role": "planning", "modelLevel": "level3" },
    { "id": "worker", "role": "implementation", "modelLevel": "level2" },
    { "id": "validator-requirements", "role": "validator", "modelLevel": "level2" }
  ]
}
```

Keys are exact agent role strings, so custom roles work too. Agents added at runtime
by conductor templates (for example the `validator` and `coordinator` agents in the
quick/heavy validation flow) inherit the mapping without any template change.

Internal agents route by their declared role: the git pusher is
`completion-detector`, and the injected stop-only completion detector is
`orchestrator`.

### Global settings

```bash
zeroshot settings set providerByRole '{"planning":"codex","validator":"gemini"}'
zeroshot settings set providerByRole.validator opencode   # preserves other roles
```

A cluster-level entry overrides the corresponding settings entry. The default is `{}`,
so configurations without any mapping behave exactly as before.

### Per-run override

```bash
zeroshot run 123 --worktree \
  --role-provider planning=codex \
  --role-provider implementation=claude \
  --role-provider validator=gemini
```

`--role-provider` merges into the cluster's `providerByRole` (CLI wins per role) and
is forwarded to detached runs via `ZEROSHOT_RUN_OPTIONS`. `--provider` still forces a
single provider for the entire run, overriding every role mapping and every explicit
agent provider.

### Preflight

Startup validates _every_ provider the routing can select — availability, auth, and
model settings — before a worktree is created or any agent runs, and reports all
failures together:

```text
codex: required by role "planning"
claude: required by roles "default", "implementation"
gemini: required by role "validator"
```

Because conductor templates add agents after preflight, a provider named in
`providerByRole` is checked even if no agent with that role exists yet.

### Docker (deferred)

Mixed-provider `--docker` runs are not supported: a single container image cannot host
multiple provider CLIs with their credentials today. Preflight fails early with:

```text
Mixed-provider role routing is not supported with --docker.
```

Use `--worktree`/`--pr`/`--ship`, or `--provider <name>` to force one provider. A role
mapping that resolves every agent to the same provider stays Docker-compatible.

### Observability

`zeroshot status <id>` shows each agent's effective provider and the layer that chose
it (`Provider: gemini (cluster.providerByRole)`), and `--json` includes `provider` and
`providerSource`. Cluster startup logs one routing summary line.

## Gateway Provider

Use `gateway` for OpenAI-compatible model endpoints such as OpenRouter,
Ollama, vLLM, or self-hosted gateways. These stay model configs behind one
provider engine; do not add them as standalone provider ids.

Required settings:

```json
{
  "providerSettings": {
    "gateway": {
      "baseUrl": "http://127.0.0.1:11434",
      "apiKey": "gateway-key",
      "model": "openrouter/meta-llama/test-model",
      "toolPolicy": {
        "roots": ["/absolute/path/to/worktree"],
        "commands": ["node"]
      }
    }
  }
}
```

Notes:

- `toolPolicy` is required. There is no default file or shell access.
- `headers` is optional for extra gateway-specific request headers.
- `model` may be any non-empty provider-specific model id.

## Model Levels

Zeroshot uses provider-agnostic levels:

- `level1`: cheapest/fastest
- `level2`: default
- `level3`: most capable

Set levels per provider in settings:

```json
{
  "providerSettings": {
    "codex": {
      "minLevel": "level1",
      "maxLevel": "level3",
      "defaultLevel": "level2",
      "levelOverrides": {
        "level1": { "model": "codex-model-main", "reasoningEffort": "low" },
        "level3": { "model": "codex-model-main", "reasoningEffort": "xhigh" }
      }
    }
  }
}
```

Notes:

- `reasoningEffort` accepts `low`, `medium`, `high`, `xhigh`, or `max`.
- Claude passes reasoning effort to Claude Code as `--effort`.
- Codex passes reasoning effort as the `model_reasoning_effort` config override.
- Opencode passes reasoning effort as `--variant`.
- `model` is still supported as a provider-specific escape hatch.

### Current explicit model IDs

Zeroshot keeps provider-agnostic `modelLevel` defaults and also recognizes these
provider-specific IDs for explicit overrides:

- Codex: `gpt-5.6` (alias for Sol), `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`.
- Claude aliases: `haiku`, `sonnet`, `opus`, and `fable`.
- Claude current IDs: `claude-fable-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`,
  `claude-opus-4-5-20251101`, `claude-sonnet-5`, `claude-sonnet-4-6`,
  `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`,
  `claude-haiku-4-5`, and `claude-haiku-4-5-20251001`.
- Claude limited-access IDs: `claude-mythos-5` and `claude-mythos-preview`.
  Recognition does not grant account access.

The legacy Claude `maxModel` ceiling treats `fable` as a top-tier alias alongside
`opus`. Explicit canonical Claude IDs remain provider-specific overrides and are
not ranked by the legacy alias ceiling.

Sources: [OpenAI models](https://developers.openai.com/api/docs/models),
[Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
[Anthropic model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
and [Anthropic model ID rules](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).

## Docker Isolation and Credentials

Zeroshot does not inject credentials for external CLIs. When using `--docker`,
mount your provider config directories explicitly.

Examples:

```bash
# Codex
zeroshot run 123 --docker --mount ~/.config/codex:/home/node/.config/codex:ro

# Gemini (use gemini or gcloud config as needed)
zeroshot run 123 --docker --mount ~/.config/gemini:/home/node/.config/gemini:ro
zeroshot run 123 --docker --mount ~/.config/gcloud:/home/node/.config/gcloud:ro
```

Mount presets in `dockerMounts` include: `codex`, `gemini`, `gcloud`, `claude`, `opencode`.

Use `--no-mounts` to disable all credential mounts (you will get a warning if
credentials are missing).

## Provider CLI Helper

Provider command construction, feature probing, model resolution, output
parsing, error classification, redaction metadata, and executable JSON behavior
live behind the strict TypeScript helper in `src/agent-cli-provider/`.

The public process contract is `zeroshot-agent-provider`, a JSON stdin/stdout
executable for provider-only commands: `probe`, `build-command`,
`parse-output`, `classify-error`, and `invoke`.

This helper does not share Zeroshot clusters, task store, message bus,
scheduler, PR/ship flow, TUI, or orchestration policy. Consumers such as
Orchestra must call the JSON executable contract and must not import Zeroshot
internals.

See `docs/provider-cli-helper.md` for the ownership boundary, non-goals, rollout
rules, and required verification commands.

## Live Provider Smoke Tests

The normal test suite is deterministic and offline. To verify a provider against
the real installed CLI or a real gateway endpoint, run the opt-in live smoke
command:

```bash
ZEROSHOT_LIVE_PROVIDERS=all npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=claude,codex,gemini npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=pi npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=copilot npm run test:providers:live
```

Gateway requires endpoint settings:

```bash
ZEROSHOT_LIVE_PROVIDERS=gateway \
  ZEROSHOT_LIVE_GATEWAY_BASE_URL=https://openrouter.ai/api/v1 \
  ZEROSHOT_LIVE_GATEWAY_API_KEY=... \
  ZEROSHOT_LIVE_GATEWAY_MODEL=openai/gpt-5.4 \
  npm run test:providers:live
```

The live command invokes the provider through Zeroshot's executable provider
contract and requires the provider to return the sentinel
`ZEROSHOT_LIVE_SMOKE_OK`. It is not part of CI because it may require local
auth, network access, and paid API calls.

### GitHub Actions Live Smoke

Use the `Live Provider Smoke` workflow for release-gating real providers. It is
manual by default and scheduled only when the repository variable
`ZEROSHOT_LIVE_PROVIDER_SMOKE_ENABLED` is set to `true`.

Recommended release gate:

```text
claude,codex,gemini,copilot,gateway
```

Run `all` only on a runner that also has Opencode, Pi, and Kiro installed and
authenticated. The workflow fails selected providers when the executable or
required credential is missing; it does not convert missing live coverage into a
passing skip.

Credential names:

| Provider | Required CI credential                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| Claude   | `ZEROSHOT_LIVE_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`                                         |
| Codex    | `ZEROSHOT_LIVE_OPENAI_API_KEY` or `OPENAI_API_KEY`                                               |
| Gemini   | `ZEROSHOT_LIVE_GEMINI_API_KEY` / `ZEROSHOT_LIVE_GOOGLE_API_KEY`                                  |
| Copilot  | `ZEROSHOT_LIVE_COPILOT_GITHUB_TOKEN`                                                             |
| Gateway  | `ZEROSHOT_LIVE_GATEWAY_BASE_URL`, `ZEROSHOT_LIVE_GATEWAY_API_KEY`, `ZEROSHOT_LIVE_GATEWAY_MODEL` |
| Kiro     | `ZEROSHOT_LIVE_KIRO_API_KEY` plus a runner with `kiro-cli` installed                             |
| Pi       | A runner with `pi` installed and authenticated                                                   |
| Opencode | A runner with `opencode` installed and authenticated                                             |
