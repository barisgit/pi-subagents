# Sources

Access date: **2026-07-15**. Only sources actually fetched, transcribed, or inspected are listed. Video captions were automatic English captions and may contain wording or speaker-attribution errors.

## Video evidence

### Linked Nerd Snipe discussion

- [Nerd Snipe — “We’re back to ‘too many models’”](https://www.youtube.com/watch?v=bjW7nL3l08g), 2026-07-14. Full transcript inspected.
  - [1:19:42](https://www.youtube.com/watch?v=bjW7nL3l08g&t=4782s): criticism of copying full parent history into children.
  - [1:23:29](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5009s): generated workflow described as code with multiple stages/calls.
  - [1:28:34](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5314s): criticism of fixed researcher/implementation personas with hardcoded prompts, models and permissions.
  - [1:28:54](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5334s): bounded generated workflow presented as the desirable dynamic/static middle ground.
  - [1:29:31](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5371s): criticism of recursively spawned, communicating subagents.
  - [1:31:54](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5514s): workflow and subagent should be distinct first-class concepts and UI entities.
  - [1:33:06](https://www.youtube.com/watch?v=bjW7nL3l08g&t=5586s): prompts need explicit stopping points.
  - [1:43:39](https://www.youtube.com/watch?v=bjW7nL3l08g&t=6219s): Pi praised for a less polluted system prompt.

### Theo / t3.gg

- [“A proper guide to Fable 5”](https://www.youtube.com/watch?v=8GRmLR__OGQ), 2026-07-06. Full transcript inspected.
  - [7:46](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=466s): avoid reasoning effort above high because workflows are triggered too aggressively.
  - [14:04](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=844s): task-specific worker archetypes should be invented dynamically rather than predefined.
  - [15:58](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=958s) and [17:24](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1044s): model-routing rubric based on intelligence, taste and price.
  - [25:34](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1534s): fan-out review workflow over many PRs.
  - [29:23](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1763s): one umbrella workflow is wrong for checkpoint-driven PR work.
  - [30:02](https://www.youtube.com/watch?v=8GRmLR__OGQ&t=1802s): parallelize only sufficiently independent plans; use workflows for targeted review.
- [“GPT-5.6: The Review”](https://www.youtube.com/watch?v=IyoTJHLmClo), 2026-07-12. Full transcript inspected.
  - [22:01](https://www.youtube.com/watch?v=IyoTJHLmClo&t=1321s): Soul characterized as highly persistent.
  - [23:39](https://www.youtube.com/watch?v=IyoTJHLmClo&t=1419s): Fable 5, GPT-5.6 Soul and Sonnet 5 described as notably capable orchestrators.
- [“FABLE IS BACK”](https://www.youtube.com/watch?v=KSV-7ywHxeU), 2026-07-01. Full transcript inspected.
- [“I guess we’re writing loops now?”](https://www.youtube.com/watch?v=iJVJwmCKW9o), 2026-06-18. Full transcript inspected.
  - [6:54](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=414s): rejection of hardcoded predefined subagent structures.
  - [14:22](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=862s): example of a dynamically generated workflow whose loops create task-specific subloops.
  - [17:58](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=1078s): agents should review work before consuming human review time.
  - [19:23](https://www.youtube.com/watch?v=iJVJwmCKW9o&t=1163s): reported eight-hour, three-million-token overreaction to small review feedback.
- [“How I code with AI changed a lot”](https://www.youtube.com/watch?v=xJaMTo2YgO8), 2026-05-27. Full transcript inspected as earlier context on parallel threads and clean context.

### Nerd Snipe model discussions

- [“We Tested GPT 5.6 Sol Early”](https://www.youtube.com/watch?v=sQ07OcRzMqo), 2026-07-09. Full transcript inspected.
  - [48:57](https://www.youtube.com/watch?v=sQ07OcRzMqo&t=2937s): comparison between generated workflow code and native Codex subagent primitives.
  - [49:24](https://www.youtube.com/watch?v=sQ07OcRzMqo&t=2964s): workflow stages may generate zero, one or many workers based on earlier results.
  - [56:07](https://www.youtube.com/watch?v=sQ07OcRzMqo&t=3367s): practitioner comparison of Codex verification and Fable collaboration/taste.
- [“They Launched GPT 5.6”](https://www.youtube.com/watch?v=5r2qi7AcEVo), 2026-06-30. Full transcript inspected.
- [“Fable Is (50%) Back”](https://www.youtube.com/watch?v=s6dgBR_02fM), 2026-07-08. Full transcript inspected.
  - [43:41](https://www.youtube.com/watch?v=s6dgBR_02fM&t=2621s): Fable praised for constructing context and workflows dynamically.
  - [57:39](https://www.youtube.com/watch?v=s6dgBR_02fM&t=3459s): X-high subagent fan-out reportedly consumed about 30% of weekly usage for little benefit.
- [“Fable is still banned”](https://www.youtube.com/watch?v=qfSgN9i5Fd4), 2026-06-24. Full transcript inspected.

## Official harness and vendor documentation

- [Claude Code: Common workflows](https://code.claude.com/docs/en/workflows). Inspected for generated JavaScript workflows, stages, model routing, intermediate-state isolation, branching, loops and fan-out.
- [Claude Code: Choose the right agent type](https://code.claude.com/docs/en/agents). Inspected for the distinction among subagents, agent view, agent teams and workflows.
- [Claude Code: Create custom subagents](https://code.claude.com/docs/en/subagents). Inspected for isolated context, summary return, model/effort/tools/permissions/skills/isolation/max-turn configuration.
- [Claude Code: Orchestrate teams](https://code.claude.com/docs/en/agent-teams). Inspected for communicating teams, worktree use, token cost, and warnings about sequential, same-file, dependency-heavy work.
- [Claude Code: Configure models](https://code.claude.com/docs/en/model-config). Inspected for model and reasoning configuration.
- [OpenAI Codex: Subagents](https://developers.openai.com/codex/concepts/subagents). Inspected for native subagent threads, direct/manual invocation, roles, inspection, steering, stopping and token-cost warning.
- [OpenAI Codex: Build a coding agent with the Agents SDK](https://developers.openai.com/codex/guides/agents-sdk/). Inspected for deterministic handoff pipelines.
- [OpenAI: Introducing GPT-5.6](https://openai.com/index/introducing-gpt-5-6/). Inspected for beta concurrent multi-agent/subagent claims.
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). Inspected for lead-worker architecture, internal parallel-research evaluation, token use and limits of software parallelization.
- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents). Inspected for routing, parallel sectioning/voting, orchestrator-workers, evaluator-optimizer, and “simplest effective pattern” guidance.

## Source repository revisions

All source repositories were inspected without fetching or updating. Commits identify the inspected revisions.

- Pi: commit `c6d8371521fc8357958bb21fd43552c15f46c7f4`
  - `packages/coding-agent/examples/extensions/subagent/index.ts`
  - `packages/coding-agent/examples/extensions/subagent/agents.ts`
  - `packages/orchestrator/src/supervisor.ts`
  - `packages/orchestrator/src/rpc-process.ts`
- OpenAI Codex: commit `622a79ed5667571e12e46b199fbc225fbd4ea00f`
  - `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
  - `codex-rs/core/src/tools/handlers/multi_agents.rs`
  - `codex-rs/core/src/tools/handlers/agent_jobs.rs`
  - `codex-rs/core/src/config/agent_roles.rs`
  - `codex-rs/core/src/config/mod.rs`
  - `codex-rs/core/src/context/multi_agent_mode_instructions.rs`
  - `codex-rs/tui/src/app/agent_navigation.rs`
  - `codex-rs/tui/src/app/agent_status_feed.rs`
- OpenCode: commit `31b58b470465977f9b9b6bd9a17bfe3d76f1a229`
  - `packages/opencode/src/tool/task.ts`
  - `packages/opencode/src/agent/agent.ts`
  - `packages/opencode/src/agent/subagent-permissions.ts`
  - `packages/core/src/background-job.ts`
  - `packages/opencode/src/worktree/index.ts`
  - `packages/tui/src/routes/session/subagent-footer.tsx`
- `pi-subagents`: commit `d2eb7f60d20a22ad296d8c88f4c8ac0547eb37dc`, current working repository. Relevant implementation files:
  - `src/workflow/workflow.ts`
  - `src/protocol/schemas.ts`
  - `src/dispatch/prepare-child-step.ts`
  - `src/dispatch/fork-context.ts`
  - `src/dispatch/subagent-executor.ts`
  - `src/dispatch/leaf-concurrency.ts`
  - `src/dispatch/worktree.ts`
  - `src/state/status-writer.ts`
  - `src/state/run-view.ts`
  - `src/surfaces/subagents-status.ts`

The three external checkouts were not fetched or updated during the final pass because GitHub was unavailable.

## Empirical and technical research

- [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296). Inspected in full. Evidence used: 260 configurations, task-dependent gains/losses, base-agent capability threshold, coordination overhead, error amplification and architecture-task matching.
- [Single-agent or Multi-agent? Why Not Both?](https://arxiv.org/html/2505.18286). Inspected in full. Evidence used: multi-agent advantage shrinks with stronger models; hybrid SAS/MAS routing. The abstract and body appear to disagree on the maximum reported cost reduction, so that figure is not relied upon.
- [CodeDelegator](https://arxiv.org/html/2601.14914). Inspected in full. Evidence used: persistent planner plus clean ephemeral coding contexts and specification-centric handoffs.
- [AOrchestra](https://arxiv.org/html/2602.03786). Inspected in full. Evidence used: dynamic construction of agent instruction/context/tools/model tuples and adaptive model selection.
- [Co-Coder](https://arxiv.org/html/2606.00953). Inspected in full. Evidence used: weak results from naive file-parallelism and improvements from cohesion/dependency-aware partitioning.
- [Faulty-agent resilience study](https://proceedings.mlr.press/v267/huang25ay.html). Inspected in full. Evidence used: hierarchy and challenger/inspector resilience under injected faults.
- [Communication-centric multi-agent analysis](https://arxiv.org/html/2510.13903). Inspected in full. Evidence used: communication value depends on retrieval, state-tracking and multihop task structure.
- [Repository-scale role-based multi-agent coding study](https://arxiv.org/html/2607.04212). Inspected in full. Evidence used as a caution: multi-agent output moved closer to developer code than a single GPT-5 baseline across 12 Java repositories but retained a substantial human/compilation gap.

## Source-quality notes

- Official documentation and pinned source establish implementation claims.
- Papers establish only their evaluated settings; several are recent preprints.
- Vendor engineering reports are useful but may use favorable internal tasks.
- Videos establish practitioner beliefs and incidents, not general causal results.
- Synthesis and recommendations are labeled as such in the report.
