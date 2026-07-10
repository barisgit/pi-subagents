import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	currentRunnerToken,
	deriveRunDisplayState,
	isRunnerHardDead,
	isRunnerIdentityDead,
} from "../../src/state/run-liveness.ts";

/** Pid of a process that has provably exited (spawnSync waits for exit). */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.ok(typeof child.pid === "number" && child.pid > 0, "spawnSync must report a pid");
	return child.pid;
}

const NOW = 100_000;

describe("runner identity liveness", () => {
	it("currentRunnerToken is stable within the process", () => {
		assert.equal(currentRunnerToken(), currentRunnerToken());
	});

	it("matching token => never identity-dead (reload case)", () => {
		assert.equal(isRunnerIdentityDead({ runnerPid: deadPid(), runnerToken: currentRunnerToken() }), false);
	});

	it("foreign token + dead pid => identity-dead immediately", () => {
		assert.equal(isRunnerIdentityDead({ runnerPid: deadPid(), runnerToken: "foreign-token" }), true);
	});

	it("foreign token + our own pid => identity-dead (pid reuse)", () => {
		assert.equal(isRunnerIdentityDead({ runnerPid: process.pid, runnerToken: "foreign-token" }), true);
	});

	it("foreign token + live foreign pid => not identity-dead (another host owns it)", () => {
		assert.equal(isRunnerIdentityDead({ runnerPid: process.ppid, runnerToken: "foreign-token" }), false);
	});

	it("absent fields => not identity-dead (old records fall back to heartbeat)", () => {
		assert.equal(isRunnerIdentityDead({}), false);
	});

	it("deriveRunDisplayState: dead identity => lost immediately despite a FRESH heartbeat", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "thinking",
			runnerHeartbeatAt: NOW - 1_000,
			runnerPid: deadPid(),
			runnerToken: "foreign-token",
			now: NOW,
		});
		assert.equal(result, "lost");
	});

	it("deriveRunDisplayState: matching token keeps heartbeat behavior (running stays live)", () => {
		const result = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - 3_000,
			runnerPid: process.pid,
			runnerToken: currentRunnerToken(),
			now: NOW,
		});
		assert.equal(result, "tool_running");
	});

	it("deriveRunDisplayState: old record without identity keeps existing heartbeat-ceiling behavior", () => {
		const fresh = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - 3_000,
			now: NOW,
		});
		assert.equal(fresh, "tool_running");
		const hardDead = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - 36_000,
			now: NOW,
		});
		assert.equal(hardDead, "lost");
	});

	it("treats an epoch-zero activity timestamp as recent", () => {
		assert.equal(
			deriveRunDisplayState({
				state: "running",
				lastActivityAt: 0,
				now: 1_000,
				workingRecentMs: 2_000,
			}),
			"working",
		);
	});

	it("isRunnerHardDead: dead identity => true with a fresh heartbeat; matching token => heartbeat only", () => {
		assert.equal(
			isRunnerHardDead({
				state: "running",
				runnerHeartbeatAt: NOW - 1_000,
				runnerPid: deadPid(),
				runnerToken: "foreign-token",
				now: NOW,
			}),
			true,
		);
		assert.equal(
			isRunnerHardDead({
				state: "running",
				runnerHeartbeatAt: NOW - 1_000,
				runnerPid: process.pid,
				runnerToken: currentRunnerToken(),
				now: NOW,
			}),
			false,
		);
		// Old-shape record (no identity fields): unchanged ceiling behavior.
		assert.equal(isRunnerHardDead({ state: "running", runnerHeartbeatAt: NOW - 31_000, now: NOW }), true);
		assert.equal(isRunnerHardDead({ state: "running", runnerHeartbeatAt: NOW - 1_000, now: NOW }), false);
	});
});
