# Research Brief: Subagent Delegation and Orchestration

**Date:** 2026-07-15

```yaml
main_question: "I want to determine the best practical architecture for subagent delegation and orchestration with current highly capable coding models, especially Claude 5 Fable and the GPT-5.6 family."

sub_questions:
  - "What does Theo advocate or reject about subagents across the full linked Nerd Snipe video and his relevant recent videos?"
  - "How do Claude Code, Codex, Pi, OpenCode, and other important harnesses actually implement context transfer, model selection, delegation, workflows, recursion, communication, stopping, and UI?"
  - "What do recent empirical papers and technical evaluations show about when multi-agent orchestration helps or hurts versus one strong agent?"
  - "What do experienced practitioners report works in production coding-agent workflows, including contrary views?"
  - "What architecture and operating rules best fit frontier models with asymmetric strengths, costs, and persistence?"

scope:
  in_scope:
    - "Full linked Nerd Snipe video and relevant uploads from Nerd Snipe and Theo/t3.gg from approximately 2026-06-15 through 2026-07-15, with older directly relevant context where necessary"
    - "Primary vendor documentation and locally inspected source code for coding-agent harnesses"
    - "Peer-reviewed papers, preprints with technical detail, benchmark/evaluation reports, and named practitioner articles or talks"
    - "Delegation topology, context isolation, structured handoffs, heterogeneous model routing, concurrency, depth, worktree isolation, stopping and cost controls, observability, and failure modes"
  out_of_scope:
    - "Generic autonomous-agent surveys without delegation evidence"
    - "SEO listicles, affiliate comparisons, and unverified social-media anecdotes"
    - "Non-coding multi-agent domains unless they provide transferable empirical evidence"
    - "Model capability ranking unrelated to orchestration"
  time_horizon: "Primary focus on 2025-2026; foundational earlier work included only when still operationally relevant"
  geography: "global"
  depth: "comprehensive decision-oriented report"

keywords:
  primary: ["subagent", "agent orchestration", "delegation", "multi-agent coding", "workflow agent"]
  secondary: ["context engineering", "handoff", "hierarchical agent", "agent swarm", "parallel coding agents", "mixture of agents", "multi-agent debate", "worktree", "token budget"]
  exclude: ["SEO top tools", "generic chatbot", "affiliate"]

source_preferences:
  prefer:
    - "Official model and harness documentation"
    - "Source repositories inspected through BTCA Local"
    - "Peer-reviewed papers and technically complete preprints"
    - "Named practitioner engineering reports with concrete workflows or measurements"
    - "Timestamped first-party video transcripts"
  deprioritize:
    - "Undated SEO listicles"
    - "Content-farm rewrites"
    - "Vendor marketing without implementation detail or reproducible evidence"
  minimum_sources_per_subquestion: 2

success_criteria:
  - "Accurately reconstruct Theo's current position with timestamped evidence and distinguish it from co-host statements"
  - "Compare at least five harness approaches using primary docs or source code"
  - "Include multiple empirical research sources and multiple named practitioner sources, with disagreements surfaced"
  - "Explain which conclusions change because frontier models can plan, delegate, and review more competently"
  - "Provide a concrete recommended architecture, dispatch policy, model-routing policy, anti-patterns, and evaluation plan"
  - "Cross-verify every load-bearing factual claim or label it REPORTED/OPINION/SYNTHESIS"

output:
  shape: "decision-oriented research report with comparison tables and annotated evidence"
  audience: "Owner of a sophisticated Pi subagent extension deciding how orchestration should work"
  length_target: "full report, concise enough to use operationally"

risks_and_assumptions:
  - "Theo's channel means Theo / t3.gg; the linked Nerd Snipe channel is analyzed separately"
  - "Recent means roughly the last month relative to 2026-07-15"
  - "Claude 5 Fable and GPT-5.6 naming may be very recent and documentation may lag product behavior"
  - "Video automatic captions may contain transcription and speaker-attribution errors"
  - "Harness implementations change quickly; source commit/date will be recorded"
```

## Planned search angles

1. Video position: channel uploads, transcripts, exact subagent/model/workflow passages, contradictions over time.
2. Harness implementation: official docs plus source inspection for model routing, context transfer, nesting, workflows, communication and UI.
3. Empirical research: multi-agent scaling, debate/ensembling, hierarchical delegation, failure amplification, coordination overhead, and coding-agent evaluations.
4. Practitioner evidence: detailed reports from harness authors, model vendors, coding-agent teams and experienced independent developers; include skeptics.
5. Verification: independent source review, recency checks, URL/content verification, and an adversarial challenge to the proposed architecture.
