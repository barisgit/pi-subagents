import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";

export interface ResolveChildSessionFileOpts {
	parentCwd: string;
	parentSessionFile: string | null;
	runId: string;
	stepIndex: number;
	sessionDirOverride?: string;
	defaultSessionDir?: string;
	/**
	 * Source session file to seed the child's session.jsonl from (fork-reuse).
	 * The child still gets its OWN session file at the canonical path; only the
	 * inherited entries are copied across at session-open time.
	 */
	forkContextFile?: string;
}

export interface ResolvedChildSessionFile {
	/** The per-run root that contains status.json + run-N/ step subdirs. */
	runRecordDir: string;
	/** The per-step session.jsonl file path. Lives under <runRecordDir>/run-<stepIndex>/. */
	sessionFile: string;
	/** Alias of runRecordDir kept for backwards compatibility with older callers. */
	sessionRoot: string;
}

export function resolveChildSessionFile(opts: ResolveChildSessionFileOpts): ResolvedChildSessionFile {
	void opts.parentCwd;
	// Fork-reuse no longer collapses runRecordDir onto the parent's session
	// directory; the child gets its own canonical run dir and copies parent
	// entries into its own session.jsonl at session-open time (see
	// in-process-executor.ts seedForkSessionFile).

	const baseRoot = opts.sessionDirOverride
		?? opts.defaultSessionDir
		?? (opts.parentSessionFile
			? path.join(path.dirname(opts.parentSessionFile), path.basename(opts.parentSessionFile, ".jsonl"))
			: mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-")));
	// Layout:
	//   <runRecordDir>/         (== sessionRoot == baseRoot/<runId>)
	//     status.json           — written by parent's StatusWriter
	//     run-<stepIndex>/
	//       session.jsonl       — written by pi-coding-agent SessionManager
	const runRecordDir = path.join(baseRoot, opts.runId);
	const sessionFile = path.join(runRecordDir, `run-${opts.stepIndex}`, "session.jsonl");
	return {
		runRecordDir,
		sessionFile,
		sessionRoot: runRecordDir,
	};
}
