# Subagent delegation with frontier coding models

**Decision report — 2026-07-15**  
**Audience:** maintainer of `pi-subagents`  
**Evidence window:** recent Theo/Nerd Snipe videos, current vendor documentation, local harness source, and 2025–2026 multi-agent research

## Executive decision

Keep the current hybrid architecture, but describe and govern it more precisely:

1. **Use one strong agent by default.** Delegate only when the work has a real decomposition boundary, context-isolation benefit, specialized capability, independent verification need, or background-latency benefit.
2. **Keep only a small configured policy catalog, and admit where it is semantic.** Stable entries are justified when they enforce different mutation policy, tools, modality, independence, or execution economics. Let the parent invent the task-specific identity in the task packet and output schema.
3. **Prefer a centralized orchestrator with fresh, ephemeral workers.** Do not default to peer-to-peer swarms. Keep recursive delegation bounded and make child-to-child communication exceptional.
4. **Use generated workflows for bounded, stage-shaped work.** Use direct subagents for one bounded handoff or a fixed independent batch. Use a persistent parent thread for checkpoint-driven work that needs human or CI decisions between stages.
5. **Route models by capability and economics.** Frontier orchestration models should decide decomposition; cheaper or more specialized models should perform suitable leaves; an independent strong reviewer should inspect risky results.
6. **Add hard budgets before relying on long autonomous runs.** The current depth and concurrency controls limit shape, not total token or wall-clock consumption. Per-run limits for leaves, turns, elapsed time, and optionally tokens/cost would close that capability gap; local telemetry should determine its priority.
7. **Evaluate routing on real repository tasks.** Compare single-agent, bounded workflow, parallel workers, and orchestrator-plus-review against pass rate, wall time, tokens, merge conflicts, retries, and human corrections.

The central conclusion is not “multi-agent is better.” It is:

> **Use delegation as a routing decision. The expected gain from decomposition, isolation, specialization, or independent verification must exceed coordination cost and error amplification.**

## Answer to the original Theo question

Your initial instinct was mostly right, but “we do everything differently” is too strong.

Theo’s criticism is aimed at two bad extremes:

- **predefined semantic personas** with fixed prompts, models, and permissions; and
- **unbounded recursive spawning** where agents create and message peers continuously.

He favors a middle layer: the model writes a bounded workflow for the task, chooses the buckets and worker styles at runtime, and then executes that finite program. In the linked video he calls this “a really good balance” because the plan is dynamic before execution but comparatively static once running ([1:28:54](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5334s)).

`pi-subagents` already implements much of that middle layer:

- `workflow({ script })` provides generated JavaScript with `agent`, `parallel`, `pipeline`, `phase`, loops, branches, retries, runtime fan-out, and schema-validated child outputs (`src/workflow/workflow.ts`).
- Fresh context is the default; conversational copying is explicit and limited to same-role forks (`src/dispatch/fork-context.ts`, `src/dispatch/prepare-child-step.ts`).
- Recursion is depth-limited and delegation can be denied or allowlisted by role (`src/shared/runtime-env.ts`, `src/dispatch/subagent-executor.ts`).
- A process-wide semaphore bounds active leaves (`src/dispatch/leaf-concurrency.ts`).
- Worktrees isolate parallel edits (`src/dispatch/worktree.ts`).
- Runs and workflows are persisted and surfaced separately (`src/state/status-writer.ts`, `src/state/run-view.ts`, `src/surfaces/subagents-status.ts`).

What remains static is the role contract: system instructions, tools, skills, permissions, model and reasoning defaults. That is a real difference from Theo’s ideal. The design is defensible if those roles are treated as **security/capability/execution profiles**, not as a taxonomy of people. The task-specific identity should be generated dynamically in the dispatch message.

## What Theo’s recent position actually is

### 1. He rejects hardcoded semantic roles, not every stable execution contract

In “I guess we’re writing loops now?” he compares pre-built subagents to a coding template where every file already exists and calls that approach “stupid”; what attracts him is agents constructing the method for each problem ([6:54](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=414s)). In “A proper guide to Fable 5,” he says predefined review, adversarial-review, and exploration archetypes make less sense because the model can invent them for the specific task ([14:04](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=844s)).

The charitable and useful reading is narrower than “configuration is bad”:

- Static **task semantics** become brittle when the model can compose better semantics from live context.
- Static **capability boundaries** remain useful for permissions, tool access, model routing, isolation, and auditability.

Our architecture should preserve the second while avoiding the first.

### 2. He strongly prefers model-authored workflows

The linked video describes Claude’s workflow primitive as generated code with stages and programmatic fan-out ([1:23:29](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5009s)). A recent Nerd Snipe comparison repeats the important property: one worker’s result can generate zero, one, or many workers in a later stage ([49:17](https://www.youtube.com/watch?v=sQ07OcRzMqo&t=2957s)).

This is materially different from selecting “researcher, implementer, reviewer” from a fixed menu. It lets the model determine both the decomposition and the worker instructions from the actual task.

### 3. He does not think one giant workflow fits every long program

A useful qualification appears in the Fable guide. For a sequence of PRs with CI, review, merges, rebases, and product decisions, the model says one umbrella workflow is wrong: workflows shine for fan-out and verification, while the overall program is checkpoint-driven ([29:23](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1763s)). It recommends separate threads and targeted workflows only where independence exists ([30:02](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1802s)).

That distinction maps cleanly onto our tools:

- `subagent`: one bounded ownership transfer;
- fixed parallel batch: known independent leaves;
- `workflow`: bounded program whose later steps depend on earlier results;
- durable task/charter and human checkpoints: long-running program with external decisions.

### 4. He values heterogeneous model routing

Theo gives the orchestrator a rubric for model intelligence, taste, and cost, then lets it choose models for different calls ([15:58](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=958s), [17:24](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1044s)). In the GPT-5.6 review he says 5.6 Soul, Fable 5, and Sonnet 5 are the current models with notably strong decomposition instinct ([23:39](https://www.youtube.com/watch?v=IyoTJHLmClo&t=1419s)). These are practitioner judgments, not controlled benchmark findings, but they support capability-aware routing rather than one model everywhere.

### 5. He repeatedly warns that orchestration can waste extraordinary amounts of compute

Examples from the recent videos:

- He advises against Fable reasoning settings above high because they trigger workflows too aggressively ([7:46](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=466s)).
- One feedback loop reportedly ran eight hours and used more than three million tokens for three small comments ([19:23](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=1163s)).
- An X-high subagent run reportedly consumed about 30% of a weekly allowance “for basically nothing” ([57:39](https://www.youtube.com/watch?v=s6dgBR_02fM&t=3459s)).
- The linked video recommends explicit stopping points because otherwise the model may never choose to end ([1:33:06](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5586s)).

This demonstrates a real capability gap in our current implementation, but not necessarily its highest-priority defect: the cited incidents occurred in other harnesses and more autonomous modes. Depth two and a concurrency pool prevent geometric explosion, but they do not cap sequential leaves, turns, duration, or spend. Budget work should move up the queue if local telemetry shows long autonomous workflows, repeated retries, or material overspend.

### 6. He is aware of Pi, but not demonstrably this extension

The linked video explicitly says harnesses like Pi benchmark well and are pleasant because their prompts are less polluted ([1:43:39](https://www.youtube.com/watch?v=bjW7nL3l08g&t=6219s)). Nothing in the segment demonstrates familiarity with this specific extension’s generated workflows, persistence, worktrees, presets, or delegation guards.

## What the empirical evidence says

The research literature is more skeptical than product demonstrations.

### Delegation helps most when the task is decomposable

“Towards a Science of Scaling Agent Systems” evaluates 260 configurations across six benchmarks, five orchestration architectures, and three model families. Reported outcomes range from about **+80.8%** on a favorable decomposable task to **−70%** on sequential planning. Its learned predictor reaches cross-validated **R² 0.373**, useful evidence that task features matter but not a universal routing law. It also reports diminishing or negative returns when the base single-agent accuracy is already around 45% or higher, and much worse error amplification for independent agents than centralized coordination ([paper](https://arxiv.org/html/2512.08296)).

Operational conclusion: when one agent already solves a particular task class reliably, delegation has less room to help. Do not infer a universal threshold from the model name or use more agents merely because the harness can.

### Adaptive single-agent/multi-agent routing beats a universal policy

“Single-agent or Multi-agent? Why Not Both?” reports that multi-agent advantage shrinks as underlying models improve and proposes routing between single- and multi-agent execution. It reports accuracy gains of roughly **1.1–12%** from hybrid routing. Its body and abstract appear to disagree on the maximum cost reduction, so that particular cost number should not drive a decision ([paper](https://arxiv.org/html/2505.18286)).

Operational conclusion: implement an explicit dispatch gate and measure it. “Always delegate” and “never delegate” are both poor defaults.

### Clean worker context is an architectural advantage

CodeDelegator uses a persistent planner and ephemeral coding workers whose contexts contain the task specification rather than the planner’s accumulated debugging history ([paper](https://arxiv.org/html/2601.14914)). This aligns with both Theo’s objection to copying full history ([1:19:42](https://www.youtube.com/watch?v=bjW7nL3l08g&t=4782s)) and Anthropic’s isolated-subagent guidance.

Operational conclusion: fresh should remain the default. Handoffs should contain a compact task packet, not a transcript.

### File-parallelism is not enough; partition by cohesion and dependencies

Co-Coder reports that naive file-based parallelization costs about 44% more for negligible pass-rate improvement, while cohesion/dependency-aware partitioning improves both quality and cost on its evaluated repository tasks ([paper](https://arxiv.org/html/2606.00953)).

Operational conclusion: dispatch slices by independently verifiable behavior or subsystem ownership. Files are implementation details, not decomposition boundaries.

### Hierarchy and independent challenge are safer than flat independence

A fault-injection study finds hierarchical arrangements more resilient than independent peers and reports large recovery gains from challenger/inspector roles ([paper](https://proceedings.mlr.press/v267/huang25ay.html)). Another communication analysis finds that the value of messaging depends on task structure: it can help state tracking and multihop reasoning but adds little for simple retrieval ([paper](https://arxiv.org/html/2510.13903)).

Operational conclusion: keep a parent responsible for global consistency. Add a fresh reviewer where risk justifies it. Do not introduce unrestricted peer chat as a default feature.

### Vendor results support multi-agent research, not universal multi-agent coding

Anthropic reports that a lead-plus-workers research system outperformed a single Opus agent by 90.2% on an internal parallel research evaluation, but used roughly 15 times the tokens of chat and explicitly notes that software work is less parallelizable than broad research ([engineering report](https://www.anthropic.com/engineering/multi-agent-research-system)). Anthropic’s broader guidance still recommends starting with the simplest effective pattern and adding routing, parallelism, orchestrator-workers, or evaluator-optimizer loops only when the task warrants them ([guide](https://www.anthropic.com/research/building-effective-agents)).

Operational conclusion: research fan-out is a best case. Do not generalize its gains to tightly coupled repository changes.

## Harness comparison

The table distinguishes vendor documentation from locally inspected source. Local repository evidence is pinned to the commits recorded by Repo Explorer.

| System | Context and role model | Orchestration shape | Controls and isolation | Main lesson |
|---|---|---|---|---|
| **`pi-subagents` on Pi** (`d2eb7f60`) | Fresh by default; explicit same-role fork. Small configured role/preset catalog controls model, tools, skills and delegation policy. | Direct handoff, fixed parallel batch, and generated JavaScript workflow with schema outputs and runtime branching/fan-out. | Depth guard, role allowlists, global leaf semaphore, optional worktrees, async lifecycle, persisted status/dashboard. No hard run/token/turn budget. | Closest to the bounded dynamic middle ground. Preserve the policy layer; make task semantics dynamic and add budgets. |
| **Claude Code** (official docs) | Custom subagents can set model, effort, tools, permissions, skills, isolation and maximum turns. Isolated context returns a summary. | Subagents, an agent view, experimental communicating teams, and generated JavaScript workflows. | Worktree isolation; explicit team limitations; workflow scripts retain intermediate state outside parent context. | Richest separation of one-off agents, teams, and workflows. Its own docs warn teams are expensive and poor for sequential or same-file work. |
| **OpenAI Codex** (`622a79ed5667`) | Role files plus conditional per-call model/reasoning overrides. `fork_turns` selects full, partial or no parent history; full is the documented default. | Native `spawn`, message, follow-up, wait, interrupt and list tools; the model may create agents throughout a turn. Batch agent jobs exist, but there is no equivalent upfront finite workflow DSL in the inspected core. | Configurable thread cap, V1 default depth one, optional worker runtime limit (disabled by default), wait timeouts and TUI status/navigation. All agents share one working directory. | More context/model control than the video implies, but intentionally continuously agentic and therefore harder to bound and inspect than a generated workflow. |
| **OpenCode** (`31b58b470465`) | Each child is a persisted session with `parentID`, independent history and derived permissions. Agent modes are `primary`, `subagent` or `all`; model is configured on the agent or inherited from the parent. | A `task` tool creates/resumes a child and returns its final text. Experimental background mode injects completion into the parent. No generated workflow/DSL layer; delegation is model-driven tool use. | Per-agent step limit; child delegation denied by default unless explicitly allowed. SQLite persists sessions, but background jobs are process-local. No explicit subagent concurrency/token cap. Worktrees exist but are not automatically one-per-child. | Strong session and permission boundaries; weaker programmatic control, typed handoffs and durable background ownership than `pi-subagents`. |
| **Pi core/example extension** (`c6d8371521fc`) | Example roles are Markdown/frontmatter definitions. Each child is a separate `pi --mode json --no-session` process and returns final text. | Example tool supports single, parallel and fixed chain modes; upstream orchestrator separately manages Pi processes over RPC. No generated workflow engine in the example. | Parallel batch max eight with four active processes, abort escalation and usage display. No child persistence, worktree isolation or token budget in the example. | Pi’s narrow extension API makes richer policies possible without baking them into the host; `pi-subagents` replaces subprocess examples with a deeper in-process, persistent implementation. |

Official references: [Claude workflows](https://code.claude.com/docs/en/workflows), [Claude agent comparison](https://code.claude.com/docs/en/agents), [Claude subagents](https://code.claude.com/docs/en/subagents), [Claude agent teams](https://code.claude.com/docs/en/agent-teams), [Codex subagents](https://developers.openai.com/codex/concepts/subagents), and [Codex Agents SDK guide](https://developers.openai.com/codex/guides/agents-sdk/).

## Recommended architecture for `pi-subagents`

### A. Dispatch gate: single agent first

Delegate only when at least one positive condition is material and no blocking condition dominates.

| Positive signal | Why delegation can win |
|---|---|
| Independent work products | Parallel wall-clock reduction without shared-state contention |
| Large exploratory search space | Context isolation and coverage from multiple lenses |
| Specialized tool or modality | Route to a worker with materially better capability |
| Independent review is valuable | Reduces correlated oversight and protects human attention |
| Background latency | Parent can continue useful work while a bounded child runs |
| Context pollution risk | Ephemeral worker receives only the clean specification |

| Blocking signal | Preferred response |
|---|---|
| One small or tightly coupled change | Keep it inline |
| Sequential plan where each step changes the next | One persistent agent or a checkpointed pipeline |
| Multiple workers would edit the same ownership surface | Repartition by cohesive behavior or serialize |
| The parent already solves this class reliably | Avoid coordination overhead |
| No objective acceptance criterion | Clarify first; more agents amplify ambiguity |
| Budget cannot tolerate duplicate reasoning | Single agent plus deterministic verification |

This gate is a hand-authored conservative prior, not a validated router derived from the papers. Only the default-to-single bias and broad importance of decomposition are strongly supported; the individual signals and thresholds remain untested. Start with policy text plus telemetry, then revise it from local outcomes. Do not build an opaque learned router until enough real task data exists.

### B. Small configured policy catalog, dynamic task identity

The strongest argument against our current design is that “exploration” and “review” are exactly the semantic archetypes Theo says a capable model should invent. A fully dynamic design would expose generic permission/model/tool profiles and let every task define its own worker semantics. That is a coherent option, not merely a misunderstanding of our architecture.

Our current catalog does contain semantics. Keep an entry only when it carries a durable operational distinction, for example:

- broad ownership and synthesis;
- read-only search with a strict no-mutation policy;
- focused mutation and local verification;
- independent read-only challenge with a deliberately separate context;
- runtime/visual tools;
- graphical design tools and judgment.

The case for these entries is default mutation posture, independence, modality, tools and execution economics—not that “explorer” or “reviewer” is a universally correct task decomposition. This remains a genuine disagreement with Theo’s fully dynamic preference. Avoid multiplying the catalog into domain personas, and let the parent generate the task-specific identity in a packet containing:

```text
Outcome and observable acceptance criteria
Owned scope and explicit exclusions
Relevant files/artifacts and base commit
Evidence already known; assumptions still open
Allowed tools and mutation policy
Required output schema or artifact
Budget and stop condition
Escalation condition
```

That gives Theo’s desired task-specific worker identity without discarding stable security and routing policy.

### C. Centralized hierarchy with bounded dynamic workflows

Recommended default topology:

```text
parent/orchestrator
├── fresh exploratory or implementation worker
├── fresh independent worker, only if the slice is genuinely separate
└── fresh reviewer/verifier
```

Rules:

- Treat the current maximum depth of **2** as an inherited conservative starting point, not a research-derived optimum; tune it from observed task trees and failures.
- Treat **2–4** active writers as a conservative starting range, not a validated constant; increase it only when worktrees and ownership boundaries demonstrate independence.
- Read-only research can use the configured pool more aggressively.
- Parent owns the integrated state and final decision.
- Child-to-child communication is off by default; route structured findings through the parent or workflow value.
- Use `pipeline()` when each item can advance independently through stages. Use a parallel barrier only when a later decision genuinely requires all prior results.
- Catch failures per leaf when partial results are useful; otherwise fail fast deliberately.

### D. Dated practitioner snapshot: Fable and GPT-5.6

The named assignments below are a **2026-07-15 practitioner snapshot**, not a durable evidence-backed ranking. Treat them as hypotheses to evaluate. The lasting recommendation is to route through configured capability/economy profiles and update their model mappings as evidence changes.

| Work | Preferred profile | Reason |
|---|---|---|
| Ambiguous planning, tradeoffs, architecture, synthesis, taste-sensitive review | Fable-class frontier model at high or lower | Practitioner evidence favors its collaboration and decomposition judgment; avoid max-style settings by default |
| Persistent implementation, exhaustive verification, computer/runtime work, large mechanical execution | GPT-5.6 Soul/Terra-class profile | Practitioner evidence favors persistence, tool use and verification; explicitly constrain scope to prevent overbuilding |
| Broad search and low-risk classification | Cheaper fast model | Coverage and economics matter more than maximum taste |
| Independent high-risk review | Different strong model family where practical | Reduces correlated errors and style bias |
| Simple local edit with deterministic tests | Current parent model | Handoff overhead is unlikely to pay back |

The present preset architecture is useful. The missing flexibility is per-call execution intent. If added, expose a constrained configured profile such as `economy`, `standard`, `deep-review`, or `vision` rather than arbitrary provider/model IDs. This preserves operator control over cost and permissions.

### E. Add actual budgets

Current controls answer “how many can run at once?” and “how deeply may they recurse?” They do not answer “how much may this run consume?” Add a per-run budget object inherited and subdivided by workflows:

```ts
{
  maxLeaves,
  maxConcurrentLeaves,
  maxTurnsPerLeaf,
  maxElapsedSeconds,
  maxTokens?,
  maxCost?,
  stopPolicy: "first-success" | "all" | "threshold"
}
```

Required behavior:

- every spawned leaf reserves budget before launch;
- retries consume the same parent budget;
- nested workflows receive a smaller remaining allowance;
- exhaustion is a typed stop reason, not a generic failure;
- dashboard and persisted status show allocation, use, and stop reason;
- the existing `needsAttentionAfterMs` remains an alert, not a substitute for timeout.

Start with leaves, turns, and elapsed time because provider token/cost accounting may be inconsistent.

### F. Verification pattern

Use verification in this order:

1. deterministic tests, type checks, linters, builds, or runtime assertions;
2. worker self-review against the acceptance criteria;
3. fresh independent reviewer for risky or ambiguous changes;
4. parent synthesis and human review.

Give the reviewer the task packet, diff/artifact, and verification output—not the implementer’s entire reasoning transcript. Ask for attempted refutation and evidence, not generic approval. A second agent is useful only if its perspective is independent enough to change the error distribution.

### G. Observability

The current separate `workflow` and child-run surfaces are directionally correct. Extend them with:

- model/profile and reasoning level per leaf;
- parent/child topology;
- context source: fresh, forked, resumed, or reconstructed;
- budget allocated/used;
- current phase and acceptance criterion;
- worktree path/base commit;
- stop reason: completed, threshold met, interrupted, budget exhausted, failed, or stale;
- artifact and verification receipt.

Do not expose an unstructured chat swarm as the primary UI. The operator needs topology, ownership, progress, spend and evidence.

## Anti-patterns to reject

1. **Role explosion:** dozens of named personas whose only difference is prompt prose.
2. **Delegation as effort:** a reasoning slider should not silently multiply agents.
3. **Full-history cloning:** accumulated parent conversation is not a task specification.
4. **File-count fan-out:** parallelizing by file without considering cohesion or dependencies.
5. **Peer swarm by default:** unrestricted recursion and messaging increase error amplification and make state impossible to inspect.
6. **One giant workflow:** long checkpoint-driven programs need durable state and external decisions, not a script that barrels through or stalls.
7. **Review theater:** multiple agents agreeing without independent evidence or different context.
8. **Concurrency without isolation:** simultaneous edits to the same ownership surface.
9. **Alerts presented as limits:** “needs attention after five minutes” does not stop spend.
10. **No single-agent baseline:** multi-agent success is meaningless without comparison to the same frontier model working alone.

## Evaluation plan

Start with an expensive pilot of **12–20** real completed tasks rather than synthetic toys. Four policies already mean 48–80 runs before retries; expand toward 30–50 tasks only if the pilot produces a useful routing signal. Stratify tasks by:

- read-only research vs code mutation;
- low vs high subsystem coupling;
- deterministic vs subjective acceptance criteria;
- expected duration;
- one vs multiple ownership surfaces;
- tool-heavy vs reasoning-heavy work.

Run selected tasks under four policies:

1. single frontier agent;
2. one fresh delegated worker;
3. generated workflow with bounded fan-out;
4. orchestrator, workers, and independent reviewer.

Measure:

- acceptance-test/pass rate;
- human corrections and severity;
- wall-clock time;
- total input/output/cache tokens and cost;
- number of leaves, retries, and interrupted runs;
- merge conflicts or overlapping edits;
- context size per leaf;
- reviewer findings that survive independent verification.

Then implement the simplest rules that predict a benefit. A useful first rule is likely:

```text
Delegate when independence/isolation/specialization/verification benefit is high;
stay single-agent when coupling, sequential dependence, or base-agent confidence is high.
```

Re-evaluate whenever a major model generation changes. The research suggests stronger base models reduce the default benefit of multi-agent execution.

## Final assessment

Our setup is already closer to the architecture Theo praises than to the systems he criticizes:

- dynamic generated workflow scripts;
- fresh child context;
- runtime fan-out and schema handoffs;
- heterogeneous model presets;
- bounded recursion and concurrency;
- worktree isolation;
- first-class workflow/run persistence and UI.

The remaining disagreements are productive:

- Theo would make worker archetypes and model selection more dynamic.
- We intentionally keep capability contracts and fleet routing configured for safety, auditability and cost control.
- Research supports our centralized, isolated, bounded structure more than an unrestricted dynamic swarm.

The best next experiment is **not more autonomy**. It is an explicit provisional dispatch gate plus telemetry, with inherited run budgets implemented before long autonomous workflows become routine or local data shows overspend. This preserves frontier-model flexibility while testing—rather than assuming—which controls deliver the most value here.

## Evidence limitations

- YouTube evidence uses automatic English captions; timestamps are direct but wording and speaker attribution can drift.
- Theo/Nerd Snipe statements are practitioner observations, not controlled evaluations.
- Several empirical sources are recent preprints; results may not generalize across repositories or newer models.
- Anthropic’s multi-agent research result is an internal research benchmark and a favorable parallel domain.
- Local harness comparisons are pinned snapshots, not claims about every deployed product version.
- GitHub was unavailable during the final pass; no additional repositories were cloned or updated.
