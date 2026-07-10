# src/shared/

## Responsibility

Shared is the low-level utility/persona/config layer for `pi-subagents`: filesystem codecs, path constants, runtime env guards, agent/skill discovery, formatting, logging, artifacts, and small pure selection helpers. It is imported downward by `dispatch/`, `runtime/`, `state/`, and `surfaces/`; it must not import upward into those layers. Most modules depend only on Node builtins, `protocol/*` DTO/codecs, and sibling shared helpers.

- `agents.ts` — largest leaf: discovers builtin/user/project/internal agent markdown, parses frontmatter/persona defaults, applies preset/override merging, exposes `AgentConfig`, `KNOWN_FIELDS`, `mergeAgentsForScope`, `discoverAgents`, and builtin override save/remove helpers.
- `skills.ts` — resolves skill names from project/user dirs, settings, npm package manifests, extension/builtin roots, caches reads, normalizes skill input, and builds skill injection markdown.
- `utils.ts` — miscellaneous filesystem/text/message helpers: `readStatus` validates `status.json` through `parsePersistedRunStatus`, tail/activity/session lookup, prompt temp files, XML metadata stripping, result compaction, usage/error/tool-call extraction.
- `runtime-env.ts` — reads `PI_SUBAGENT_*` env, computes temp scope/depth env, and enforces nested-delegation policy from protocol vocabulary without coupling env/os reads into protocol DTOs.
- `control-policy.ts` — pure foreground-control constants and `deriveActivityState` needs-attention timeout logic.
- `runtime-paths.ts` — canonical runtime temp path home: `BASE_TEMP_DIR`, `RUNS_DIR`, `TEMP_ARTIFACTS_DIR`; moved here so protocol stays path-free.
- `formatting.ts` — canonical pure formatting home: `formatDuration`, `formatTokens`, `formatToolCall`, `shortenPath`, and `ASYNC_NO_POLL_GUIDANCE`; `surfaces/formatters.ts` should re-export instead of owning these.
- `persona-registry.ts` — maintains extension-registered internal persona directories, validates absolute internal registrations, detects cross-extension persona name conflicts, and emits protocol error events.
- `root-role-selection.ts` — picks the root role from role flag, env, restored state, default, then first available role.
- `settings.ts` — resolves per-step behavior by overlaying step overrides on `AgentConfig` defaults for output, reads, progress, skills, and model.
- `config.ts` — locates/loads subagent config from primary or legacy `~/.pi/agent` paths and expands `~/` paths, logging parse/load failures.
- `artifacts.ts` — computes artifact directories/paths, writes input/output/json/metadata artifacts, and performs best-effort age cleanup for temp and session artifact dirs.
- `current-pi.ts` — process-global active `ExtensionAPI` holder on `globalThis` for long-lived callbacks that need the current non-stale Pi action surface after reload/session changes.
- `child-session-context.ts` — process-global `AsyncLocalStorage` singleton that scopes extension activation to the child construction async tree without leaking identity across concurrent children or host reloads.
- `file-coalescer.ts` — timer-backed per-file debounce/coalescing primitive for repeated file events.
- `frontmatter.ts` — tiny markdown YAML-ish frontmatter parser returning string key/value metadata plus body.
- `logger.ts` — swallowed-failure extension logger writing to `~/.pi/logs/extensions/pi-subagents.log` or `PI_SUBAGENTS_LOG_PATH`, never stdout/stderr.

## Design

Shared modules are deliberately small leaves that pull stable vocabulary/codecs from `protocol/` and expose reusable functions upward. The architectural rule is import direction: `dispatch/`, `runtime/`, `state/`, and `surfaces/` may import `shared/*`; `shared/*` must not import those higher orchestration/presentation layers. Two moves enforce this: runtime temp constants live in `runtime-paths.ts` instead of protocol, and presentation-neutral formatters/guidance live in `formatting.ts` instead of `surfaces/`.

Agent and skill discovery are the only broad files. `agents.ts` owns persona markdown semantics and precedence; `skills.ts` owns search-path/source precedence. Everything else is a narrow utility with explicit side effects: env reads in `runtime-env.ts`, disk paths in `runtime-paths.ts`, logs in `logger.ts`, artifacts in `artifacts.ts`, and global Pi replacement in `current-pi.ts`.

## Flow

Discovery flow: callers provide `cwd`/scope/options to `discoverAgents`; `agents.ts` loads builtin, user, project, and registered internal persona dirs, parses frontmatter with `frontmatter.ts`, applies settings/presets/overrides, merges via `mergeAgentsForScope`, filters by surface/internal visibility, and returns `AgentConfig` records. Skill flow mirrors this: `resolveSkills` normalizes requested names, discovers candidate search paths by source priority, caches mtime-keyed reads, strips skill frontmatter, and returns resolved/missing lists plus injection markdown.

Runtime flow: dispatch/runtime code reads `runtime-env.ts` for depth/nested-delegation guards, `runtime-paths.ts` for run/artifact temp roots, `utils.readStatus` for safe persisted status reads, `artifacts.ts` for artifact paths/writes/cleanup, `control-policy.ts` for needs-attention state, and `formatting.ts` for stable presentation strings without importing surfaces.

## Integration

Primary consumers are higher layers: `dispatch/*` orchestrates child runs using shared agent configs, skills, cwd/status helpers, artifacts, env guards, and formatting; `runtime/*` uses root role selection and agent discovery; `state/*` can format/parse low-level status without depending on surfaces; `surfaces/*` reuses/re-exports shared formatters. `persona-registry.ts` is the bridge for other extensions to register internal persona dirs through Pi events, while `current-pi.ts` is the guarded escape hatch for lifecycle-spanning callbacks that must call the live Pi host.

Keep new shared code leaf-shaped: depend on Node, `protocol/*`, or sibling shared modules only; if it needs dispatch execution, runtime managers, state writers, or surface rendering, it belongs above `shared/` instead.
