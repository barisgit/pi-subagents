# Claude Code Workflow Guidance — Source Reconstruction

> Reconstructed from byte-exact strings extracted from Claude Code `2.1.209`. Every quoted line is a literal string recovered from the binary (source-form `${...}` markers shown as-is, with rendered values annotated). This file is the genuine Claude guidance with citations, replacing an earlier human-authored paraphrase whose section headers occur 0 times in the binary.

## 0. What this document is (and is not)

The prior version of this file was a **human-authored paraphrase**, not Claude Code text. All four of its section headers (`## Writing Delegation Prompts`, `## Choosing Fresh vs Continued Context`, `## Planning Workflow`, `## Delegation`) appear **0 times** in the binary; the same is true of the phrases "Initial understanding", "Implementation design", "Parent review", "Approval boundary", "Choosing Fresh", "Do not delegate understanding" (as a phrase), "read-only research", "tell the user what was launched", "monitor another", "do not duplicate". The genuine Claude guidance is **sparser and structurally different**: it lives in (a) a 6-section `coordinator_mode` system prompt, (b) the `Agent`/`Task` tool description with feature-gated branches, and (c) a short Notes block injected into every non-fork child. This file reconstructs the genuine text with citations so prompts can be grounded in what Claude actually says rather than a paraphrase.

## 1. Provenance & reproducible extraction method

**Binary:** `/Users/blaz/.local/share/claude/versions/2.1.209` — Mach-O 64-bit arm64, **229.2 MB** (240,377,264 B), Bun-bundled standalone.
- `VERSION:"2.1.209"`, `BUILD_TIME:"2026-07-14T03:52:37Z"`, `GIT_SHA:"0fe048596fd45e79e99353cbe2c3d1b1ac069568"` — present as **object keys/values in a `l()` metadata object**, not as combined grep strings (a bare `grep -aboF 'BUILD_TIME 2026-...'` returns 0 matches; only the bare values resolve).
- **`__BUN`** segment: fileoff `63651840`, size `0xa7e2d9e` (176,041,374 B); `8 + moduleGraphSize == section size` verified; trailer `"\n---- Bun! ----\n"` byte-exact. **Not** Node SEA (`NODE_SEA_BLOB` = 0 occurrences).
- **cli.js blob:** `211905016 -> 231563665` (19,658,649 B / 18.75 MiB), starts `"// @bun @bytecode @bun-cjs\n(function(exports,require,module,__filename,__dirname){// Claude Code is a Beta product"`.

**Record format** (inside the bytecode-constant region): `[u64=0x10][u32 enc][u32 len][payload][pad16]`, `enc9`=UTF-8, `enc8`=UTF-16LE. Confirmed on two anchors: `@67126240` enc9 len57 -> `"You are Claude Code, Anthropic's official CLI for Claude."`; `@67125456` enc8 len380 -> observer guidance.

**Extraction recipe (deterministic; all offsets in this file reproduce):**
```
BIN=/Users/blaz/.local/share/claude/versions/2.1.209
# exact byte offset of a literal:
grep -aob -F "Trust but verify" "$BIN"
# context window at an offset:
dd if="$BIN" bs=1 skip=N count=K 2>/dev/null | strings -n 8
```
**Corrections to figures in earlier reports (must not be propagated):**
- GIT_SHA digit 20 is **`3`**, not `7`: `...e99353...` not `...e99753...`.
- "44,247 blocks" -> **79,497**; term undefined — **drop it**.
- "864 prompt-fragment strings" -> derived classification with no stated heuristic — **unverifiable, drop it**.
- `respawnFlags` counts are **201 = 52 / 209 = 56** (not "54/54"); stripping *logic* is identical across versions.
- `JVh`/`XVh` are **source-inline** in cli.js (e.g. `var YVh,JVh='Your bare assistant text does NOT reach the user...'`), **not** constant-pool lookups. The "needs string table" caveat applies only to constant-pool records (`@67126240`, `@67125456`).

## 2. Identity & system-prompt assembly (the dynamic machinery)

A child's self-identity is **selected at assembly time**, not fixed. The selector `fKn` (`@217629520`) is byte-exact:

```js
function fKn(e){
  if(En()==="vertex") return M8i;
  if(e?.isNonInteractive){
    if(e.hasAppendSystemPrompt) return Ksu;
    return Ysu;
  }
  return M8i;
}
```
Three literal prefixes (`Spg=[M8i,Ksu,Ysu]`, `pKn=new Set(Spg)` — exactly 3):
- **M8i** (`@217629654`): `"You are Claude Code, Anthropic's official CLI for Claude."` — interactive default **and** side-query path.
- **Ksu**: `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."` — non-interactive **with** an `appendSystemPrompt`.
- **Ysu**: `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` — non-interactive **without** one.

**Three call sites, all confirmed:** main assembly (`~224055525`, passes `{isNonInteractive, hasAppendSystemPrompt}`); side-query (`~221889587`, hardcodes `{isNonInteractive:!1, hasAppendSystemPrompt:!1}` -> always M8i). **Implication:** SDK-path children self-identify as Ksu or Ysu, never the CLI persona — which is exactly why self-contained task strings are mandatory, not optional.

**Final stitch** (inside `B$d`, `@224052354`):
```
t = ld([ eMn(W,i.agentContext,l), fKn({...}), ...t, ..._ ? [pvu] : [] ].filter(Boolean)), RFd(t)
```
- `ld` (`@219550602`) is literally `function ld(e){return e}` (identity; an earlier "e=>e" was a paraphrase).
- `eMn` (`@214320664`) builds the billing/attribution header `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...` (field literal confirmed `@214321350`); opt-out via `CLAUDE_CODE_ATTRIBUTION_HEADER`. Subagent runs emit **`cc_is_subagent=true`** whenever `!isMainSession` — a real server-side cost-attribution tag.
- `pvu` (`@219071663`): the `# Advisor Tool\nYou have access to an \`advisor\` tool...` preamble, appended globally **only when an advisor model is configured** (`_` truthy).

**Body builder** `TB` (`@225532517`) assembles a 21-section ordered list; dynamic sections come from `KL(e,t)` factories (`@223603435`) cached via an `iCr()`/`L7o` getter/setter, and **9 spot-checked keys reproduce as literals** (anti_verbosity, fable_identity, investigate_first, heron_brook, endconv_deferred_hint, act_dont_rederive, autonomy_append, bg-session, tool_param_json). The 21-key **order** is confirmed (`anti_verbosity@225532800 -> fable_identity@225532952 -> tool_param_json@225533000 -> investigate_first@225533088 -> session_guidance@225533133 -> ... -> autonomy_append@225533678 -> endconv_deferred_hint@225533711`).

**Priority resolution** (`dre`, `@220504748`) — byte-exact precedence: `overrideSystemPrompt` wins -> else **coordinator** (`L0() && !e`) -> else agent-definition `getSystemPrompt` -> else custom/default; `appendSystemPrompt` appended **last in both branches**. `excludeDynamicSections` (SDK option, confirmed `@224635432` + `@225132243`) strips memory + scratchpad + env_info_dynamic (uses env_info_static): **SDK-path children do not receive memory or scratchpad sections** — anything they need must be in the task string.

## 3. Delegation & worker guidance (verbatim, by topic)

Vocabulary note: Claude's internal word for a child is **"worker"**; the tool is **`Agent`** (`var fi="Agent"`, alias `UU="Task"`, both resolve the same tool, `@215521746`). `fi`/`UU` are not "subagent" — that word is rare in the corpus. Send-message is **`${th}` = `"SendMessage"`**; kill is **`${gL}`** (KillShell/KillBash aliases).

### 3.1 Coordinator system prompt (coordinator_mode, `@216700205`) — verbatim core

> You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.
> **1. Your Role** — You are a **coordinator**. Your job is to: Help the user achieve their goal · Direct workers to research, implement and verify code changes · Synthesize results and communicate with the user · Answer questions directly when possible — don't delegate work that you can handle without tools. Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them. Summarize new information for the user as it arrives.
> **2. Your Tools** — `${fi}` Spawn a new worker · `${th}` Continue an existing worker (send a follow-up to its `to` agent ID) · `${gL}` Stop a running worker.
> When calling `${fi}`:
> - Do not use one worker to check on another. Workers will notify you when they are done. (`@83413924`, also `@216702371`)
> - Do not use workers to trivially report file contents or run commands. Give them higher-level tasks.
> - Do not set the model parameter. Workers need the default model for the substantive tasks you delegate.
> - Continue workers whose work is complete via `${th}` to take advantage of their loaded context.
> - When the user has approved a specific action, quote their exact words in the worker's prompt. The worker's auto-mode check sees only the worker's own transcript — your approval is invisible unless you pass it through.
> - After launching agents, `${i}` [= tell the user what was launched] and end your response. Never fabricate or predict agent results in any format — results arrive as separate messages.

**Worker results arrive as `<task-notification>` XML** (user-role messages — they look like user input but are not): `<task-id>{agentId}</task-id>`, `<status>completed|failed|killed</status>`, `<summary>`, optional `<result>` / `<usage>` (`subagent_tokens`, `tool_uses`, `duration_ms`). The `task-id` value is the agent ID — use `${th}` with it as `to` to continue.

### 3.2 Agent/Task tool description — verbatim branches (`iPd`, `@223433481`)

**Pro-plan gate** (`Gs()==="pro"`, `@223440267`): on Pro plans the description is prepended with:
> Do not spawn agents unless the user asks. Each spawn starts cold and re-derives context you already have — it's the expensive path on this plan. A task with "multiple angles," "thorough," or several parts is not a request to spawn; handle it inline with your own tools. Only use this tool when the user explicitly says to use a subagent, or names one of the available agent types.

**When to use / When not to use:**
> When to use — Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.
> When not to use — If the target is already known, use the direct tool: `${Yi}` [= Read] for a known path, `${Td}`/grep for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

**Usage notes (the load-bearing maxims, all re-grep-confirmed):**
> - The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters. (`@223443609`)
> - **Trust but verify**: an agent's summary describes what it *intended* to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done. (`@223443751`)
> - [background-capable only] Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — **do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.** (`@223444109`)
> - **Foreground vs background**: Pass `run_in_background: false` to run an agent in the foreground when you need its results before you can proceed — e.g., research agents whose findings inform your next steps. Otherwise let it run in the background (the default).
> - Use `${th}` with the agent's ID or name to continue a previously spawned agent with its context intact; a new `${fi}` call starts fresh (except `subagent_type: "fork"`, which inherits your context).
> - `isolation: "worktree"` gives the agent its own git worktree (auto-cleaned if unchanged). `isolation: "remote"` runs in a remote CCR sandbox (always background).
> - Each agent type's model, reasoning effort, and tools come from its definition (`.claude/agents/*.md` frontmatter or SDK `agents`).

**Writing the prompt** (`@223435046`): "Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters." Bullets: explain what & why · describe what you've already learned or ruled out · give enough surrounding context for judgment calls · if you need a short response, say so ("report in under 200 words") · **Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.** Terse command-style prompts produce shallow, generic work. **"Never delegate understanding."** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

### 3.3 Fork guidance (gated behind `the()` = fork-capable; likely OFF by default)

> **When to fork** — Fork yourself (pass `subagent_type: "fork"`) when the intermediate tool output isn't worth keeping **in your context**. The criterion is qualitative — "will I need this output again" — not task size. Fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this — it inherits context and shares your cache. Forks are cheap because they share your prompt cache.
> **Don't peek.** The tool result includes an `output_file` path — do not Read or tail it. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.
> **Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.
> **Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
> If you ARE the fork — execute directly; do not re-delegate. (`@225528811`)

The **non-fork default path** (`tg_`, `@225529005`): "Use the `${fi}` tool with specialized agents when the task matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. **Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.**"

### 3.4 Notes block injected into every non-fork child (`OJr`, `@225538300`) — verbatim

> - Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
> - For clear communication with the user the assistant MUST avoid using emojis. (`@225538547`)
> - Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
> - Do NOT `${_u}` [= Write] report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create. (Files written as input to another tool are fine; this note is about report files.) (`@225538739`)

This is the one place the paraphrase doc was **actively misleading**: the real Claude rule forbids children from writing report files and demands findings as the final message. Workflow prompts that ask children to "write a report .md" fight this rule.

### 3.5 Workflow-script sandbox rule (resume-safety, constant-pool `@67316128`)

> Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.

Adjacent literals: `CLAUDE_REMOTE_WORKFLOW_SCRIPT`, `CLAUDE_REMOTE_WORKFLOW_ARGS`, `CLAUDE_WORKFLOW_NAME_ONLY`. Workers themselves run as **in-process Node `worker_threads`** (`@67073072`: `var __w=require('worker_threads');__w.parentPort.on('message',...)`), not child processes.

## 4. Workflow topology, examples & heuristics

### 4.1 Four-phase task workflow (coordinator section 4 table)
| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| **Synthesis** | **You (coordinator)** | Read findings, understand the problem, craft implementation specs (section 5) |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Workers | Test changes work |

### 4.2 Concurrency rules (coordinator section 4, verbatim)
> **Parallelism is your superpower for work that splits into genuinely independent pieces.** Workers are async. Launch independent workers concurrently — don't serialize work that can run simultaneously. When doing research, cover multiple angles. To launch workers in parallel, make multiple tool calls in a single message. **But don't parallelize simple tasks:** a question or small task that takes a handful of tool calls is faster done in a single loop (one worker) than fanned out.
> - **Read-only tasks (research)** — run in parallel freely.
> - **Write-heavy tasks (implementation)** — one at a time per set of files.
> - **Verification** can sometimes run alongside implementation on different file areas.

### 4.3 Continue vs spawn — the 6-row decision table (coordinator section 5, verbatim)
| Situation | Mechanism | Why |
|-----------|-----------|-----|
| Research explored exactly the files that need editing | **Continue** (`${th}`) with synthesized spec | Worker already has the files in context and now gets a clear plan |
| Research was broad but implementation is narrow | **Spawn fresh** (`${fi}`) | Avoid dragging along exploration noise; focused context is cleaner |
| Correcting a failure or extending recent work | **Continue** | Worker has the error context and knows what it just tried |
| Verifying code a different worker just wrote | **Spawn fresh** | Verifier should see the code with fresh eyes, not carry implementation assumptions |
| First implementation attempt used the wrong approach entirely | **Spawn fresh** | Wrong-approach context pollutes the retry; clean slate avoids anchoring |
| Completely unrelated task | **Spawn fresh** | No useful context to reuse |

Continue mechanics: a continued worker retains its **full prior transcript** — every tool call, file read, and decision — not a summary.

### 4.4 "What real verification looks like" (coordinator section 4, verbatim)
> Verification means **proving the code works**, not confirming it exists. A verifier that rubber-stamps weak work undermines everything.
> - Run tests **with the feature enabled** — not just "tests pass".
> - Run typechecks and **investigate errors** — don't dismiss as "unrelated".
> - Be skeptical — if something looks off, dig in.
> - **Test independently** — prove the change works, don't rubber-stamp.
> - **Trust but verify worker reports** — check the actual diff before relaying success.

### 4.5 Hard caps, validation & examples
- **Nesting depth** `zFr = 5` (`@216694513`); error (`@223451274`): "Subagent nesting limit reached (depth `${g}` of `${zFr}`). Complete this task directly using your tools instead of spawning another agent."
- **Fork default maxTurns** `aMs = 50` (`@224310876`).
- **Agent name** regex `X8c = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` (`@216729456`); `"main"` (`i6`) reserved (`@220500673`). *(See section 7: the per-field "max 64 / reserved-word guard" binding is reported but not independently re-bound to the name field by all analyses.)*
- **Model enum** `"sonnet","opus","haiku","fable"` — `fable` is the real 4th value (`@213835521`).
- **Worked example** (coordinator section 6): `ship-audit` fork — "Audit what's left before this branch can ship... Report a punch list — done vs. missing. Under 200 words." Plus a kill->re-direct example: stop a JWT refactor, `${th}` with "Stop the JWT refactor. Instead, fix the null pointer in src/auth/validate.ts:42...".
- **Good synthesized spec** (section 5): "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'. Commit and report the hash."

## 5. Why Claude may select richer orchestration

The harness does not always present the sparse default; several gates make the coordinator/parallel/fork surface appear or disappear:

1. **Coordinator mode** (`L0()`, resolved in `dre`) — when active, the **entire 6-section coordinator prompt** replaces the default body. This is the single biggest richness amplifier: it injects the 4-phase table, the continue/spawn decision matrix, verification doctrine, and the "don't use workers to check on workers / don't set the model / quote the user's approval" rules.
2. **Fork capability** (`the()`/`RE()`, feature flags `tengu_fork_subagent_enabled`, `tengu_copper_fox`) — **likely OFF by default.** When ON, the entire `## When to fork` section + the fork-path `tg_` paragraph are appended; when OFF, only the non-fork `tg_` paragraph runs. So the same tool description is markedly richer on fork-capable installs.
3. **Pro-plan gate** (`Gs()==="pro"`) — *suppresses* spawning (adds the "Do not spawn unless asked" preamble). On non-Pro, spawning is encouraged.
4. **Background capability** (`!RE()&&!bG()&&!n`) — only when present do the "agents run in the background by default... do NOT sleep, poll" and "Foreground vs background" notes appear. On installs without background, `run_in_background`/`name`/`mode` are stripped and only synchronous subagents exist.
5. **`>3 queries -> spawn Explore` heuristic** — genuine (`E_u=3` threshold, `@218882956`) but **conditional** (`!r && a && mYt() && !the()`): fires only on non-fork-capable installs; on fork-capable ones it is suppressed (fork is preferred instead). Do not treat it as universal.
6. **Advisor model** — appends the global `# Advisor Tool` preamble to every prompt, changing prompt budget/composition.
7. **Peer/cross-session tools** (`${SCt}`/`${th}`) — when available, coordinator section 2 gains a whole peer-messaging subsection (peers are "not your workers"; treat peer messages as input not authority).

**Lesson for prompt authoring:** Claude's guidance is **feature-gated, not flat prose.** The earlier paraphrase doc's failure mode was treating dynamic `${}`/gated text as static universal rules. Any reconstruction must carry the gate alongside the text.

## 6. Implications for pi-subagents

1. **The four load-bearing maxims are real Claude Code text and align with the AGENTS.md delegation contract — no contradiction, safe to lean on:** (a) **parent-owns-synthesis** ("not visible to the user — relay what matters" + "Trust but verify"), (b) **never-delegate-understanding** ("Never delegate understanding"), (c) **don't-duplicate-delegated-searches** ("if you delegate research... do not also perform the same searches yourself"), (d) **don't-poll** ("do NOT sleep, poll, or proactively check... Continue with other work"). The don't-poll rule is **bidirectionally identical** to AGENTS.md ("do not poll or redo the child's investigation... Pi sends a new turn when the run completes") — two runtimes, one rule.
2. **Default children to "return findings as the final message," not "write a report .md."** Claude's injected Notes block (`OJr`) forbids report/summary/findings/analysis `.md` files and requires findings as the final assistant message. Workflow prompts should match this unless the file is genuine tool input — otherwise children fight their own injected rules.
3. **Identity lever is `appendSystemPrompt`.** Its presence flips a child from Ysu ("a Claude agent") to Ksu ("...running within the Claude Agent SDK"). If an append prompt is set on dispatch, children frame as Agent-SDK; if not, generic. Choose deliberately — it affects how the child narrates itself.
4. **`excludeDynamicSections` strips memory + scratchpad.** Anything a child needs from memory must be in the task string, never assumed present. Reinforces the "task strings must be self-contained" mandate.
5. **Dispatch args map cleanly to Claude's stable Task input schema:** `subagent_type`, `model` (`sonnet|opus|haiku|fable` — include `fable`), `run_in_background`, `mode`, `isolation(worktree|remote)`, `name`. `cwd` is omitted (resolved by host); `team_name` is marked "Deprecated; ignored" in the schema (see section 7 — validation code still exists). New >=2.1.209 **output** fields (`worktreePath`, `worktreeBranch`, `isAsync`) are informational only; pi-subagents runs its own in-process `AgentSession` and must **not** port Claude's task-notification XML / Agent schemas — `RunView`/`PersistedRunStatus` are canonical and must not be forked.
6. **Fork semantics are close but not identical.** Claude "fork" = inherits full context + runs background-by-default + writes `output_file`. pi-subagents `context:"fork"` = same-role self-branch. Map `context:"fresh"`<->Claude fresh (zero context). Don't assume byte-identical semantics.
7. **The Math.random / comms-call phrasing is directly reusable** as workflow-prompt anchors: the resume-safety ban mirrors the sandbox ban; the "every turn must end in a comms-tool call" contract (`JVh`, source-inline) and "your bare assistant text does NOT reach the user" frame the child's output discipline.
8. **Reusable, adoptable pattern at approval boundaries:** the prompt-injection defense "spawn a fresh agent for user-approved actions; never relay consent via a follow-up" ("quote their exact words in the worker's prompt... your approval is invisible unless you pass it through").

## 7. Uncertainties & explicitly unverified items

- **`team_name` status is contradictory across reports.** Schema `.describe()` says "Deprecated; ignored. The session has a single im..." (byte-confirmed in 2.1.201 and 2.1.209), but teammate/swarm code still validates it ("Invalid team_name: control characters are not allowed"). Treat it as deprecated-in-schema-but-still-validated; do not assume it is inert.
- **Agent-name "max 64 / reserved-word" guard binding.** The regex `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` and `"main"` reserved are byte-confirmed, but one analysis could only find a `{1,128}` regex in an auth/identity context and could not bind the reserved-word guard specifically to the Agent-tool name field. Use the stricter form but flag the binding as not triple-confirmed.
- **`Vul()` permission-mode enum values** — NOT verified (gating identifier, does not alter corpus text).
- **Full bodies of static sections `Zh_`/`eg_`/`ng_`/`og_`** ("Executing actions with care", "Using your tools", comm style, output-style conditional) — function heads and roles confirmed; full text not dumped here to stay compact. Reproducible via the `dd | strings` recipe on their offsets.
- **`--append-system-prompt` CLI -> `dre` plumbing** (flag offset `121708754`) — unverified.
- **CLI-flag allowlist Sets** (`vte/l5`, `t3r/I4t`, `nAt/Y5e`) member lists — stripping logic identical across versions, but member drift was not diffed.
- **Two-copy phenomenon:** guidance literals appear in both a ~105 MB bytecode-constant region and a ~223 MB source region; offsets in this file cite the source region. If an offset lands slightly off, the string still resolves by `grep -aob -F`.
- **`ld` verbatim** is `function ld(e){return e}`, not the arrow `e=>e` (functionally identical; corrected from an earlier paraphrase).
- **`grep -i "Ambiguity"`** returns 18 hits — all Chevrotain parser-lib strings, none in the coordinator prompt. (An earlier report's "0 matches" claim was wrong; verdict unaffected.)
