# BACKLOG

Findings noticed while working, outside the change's scope. Path, symptom, suspected cause.

## Async-channel control notices are lost

`src/dispatch/async-job-tracker.ts` (`emitAsyncControlNotification`) + `src/dispatch/intercom-bridge.ts`.
Control notices sent to an async run (e.g. nudges) are formatted without a target; delivery logs
`no child message route registered` and the notice is dropped. Suspected cause: the intercom route
registration only covers sync-dispatch child sessions, so async-channel deliveries have no route.

## `executeChildAgent` has outgrown its function

`src/dispatch/in-process-executor.ts` — `executeChildAgent` is ~600 lines in a 1375-line file, with
~11 repeated terminal-exit patch blocks (the apply-Result-to-transcript + `runContext.runFinish()`
tail). Suspected cause: each exit site hand-rolls the same finalization; a single `finish(result)`
helper would remove the duplication and the drift risk (the R5 holds had to be added at five such
sites).

## Hold tests hang on failure instead of failing

`test/unit/in-process-executor.test.ts` and `test/unit/dispatch.test.ts` — when a hold test fails,
the process hangs on orphaned keep-alive timers instead of exiting non-zero. Suspected cause: the
hold keep-alive timer is only cleared on the success path; a failing assertion never reaches the
clear. Workaround today: `--test-force-exit`.

## One unreproduced unit flake

Observed once (fail 1) in an intermediate full `test:unit` run immediately after three mutation
runs; did not reproduce in three subsequent full runs. Suspected cause: cross-test timer state, or
machine load during mutation runs. Watch item.

## Pre-existing lint warnings in touched-area tests

- `test/unit/async-rejected-child-aggregation.test.ts:35` — `Promise<any>` on a mock seam.
- `as never` is an established partial-fake idiom in `test/unit/in-process-executor.test.ts` (28 →
  30 occurrences across this change). The escape-hatch count only tracks `as any`/`as unknown`, so
  `as never` is a loophole relative to the rule's intent.
