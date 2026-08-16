import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { __resetProcessGlobalForTest } from "../../src/shared/process-global.ts";

const RELAY_KEY = "pi.subagents.live-session-relay";

function inertSession(name: string) {
	return { name, subscribe: () => () => {} } as never;
}

beforeEach(() => {
	__resetProcessGlobalForTest(RELAY_KEY);
});

describe("live session relay", () => {
	it("retains only the latest validated in-flight tool progress for published sessions", async () => {
		const relay = await import("../../src/shared/live-session-relay.ts");
		const listeners = new Set<(event: unknown) => void>();
		const session = {
			subscribe(listener: (event: unknown) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const emit = (event: unknown) => {
			for (const listener of listeners) listener(event);
		};
		const directory = new relay.LiveSessionDirectory();
		const unpublish = relay.publishLiveSession({ runId: "run", stepIndex: 0, session: session as never });

		assert.equal(listeners.size, 1);
		emit({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: {} });
		assert.equal(directory.toolProgress(session as never).get("call")?.partialResult, undefined);
		emit({
			type: "tool_execution_update",
			toolCallId: "call",
			partialResult: { content: [{ type: "text", text: "first" }], details: { sequence: 1 } },
		});
		assert.deepEqual(directory.toolProgress(session as never).get("call")?.partialResult?.content, [
			{ type: "text", text: "first" },
		]);
		emit({
			type: "tool_execution_update",
			toolCallId: "call",
			partialResult: { content: [{ type: "text", text: "second" }], details: { sequence: 2 } },
		});
		assert.deepEqual(directory.toolProgress(session as never).get("call")?.partialResult?.content, [
			{ type: "text", text: "second" },
		]);
		emit({ type: "tool_execution_end", toolCallId: "call" });
		assert.equal(directory.toolProgress(session as never).size, 0);

		unpublish();
		assert.equal(listeners.size, 0);
		assert.equal(directory.toolProgress(session as never).size, 0);
		directory.dispose();
	});

	it("forwards malformed partial updates without mutating raw dashboard progress", async () => {
		const relay = await import("../../src/shared/live-session-relay.ts");
		const listeners = new Set<(event: unknown) => void>();
		const session = {
			subscribe(listener: (event: unknown) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const observed: unknown[] = [];
		const directory = new relay.LiveSessionDirectory({
			handleSessionEvent: (_session, event) => observed.push(event),
			releaseSession: () => {},
		});
		const unpublish = relay.publishLiveSession({ runId: "run", stepIndex: 0, session: session as never });
		const emit = (event: unknown) => {
			for (const listener of listeners) listener(event);
		};

		emit({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: {} });
		const progressBefore = directory.toolProgress(session as never).get("call");
		const malformedUpdate = {
			type: "tool_execution_update",
			toolCallId: "call",
			toolName: "bash",
			args: { command: "printf still-running" },
			partialResult: { content: [{ type: "audio", data: "invalid-dashboard-content" }] },
		};
		emit(malformedUpdate);

		assert.deepEqual(directory.toolProgress(session as never).get("call"), progressBefore);
		assert.equal(observed.at(-1), malformedUpdate, "observer still receives args and execution state");

		unpublish();
		directory.dispose();
	});

	it("crosses module instances, orders sessions by step, and removes only the published session", async () => {
		const url = new URL("../../src/shared/live-session-relay.ts", import.meta.url).href;
		const host = (await import(`${url}?host`)) as typeof import("../../src/shared/live-session-relay.ts");
		const child = (await import(`${url}?child`)) as typeof import("../../src/shared/live-session-relay.ts");
		const released: unknown[] = [];
		const directory = new host.LiveSessionDirectory({
			handleSessionEvent: () => {},
			releaseSession: (session) => released.push(session),
		});
		const stepTwo = inertSession("step-two");
		const stepZero = inertSession("step-zero");
		const replacement = inertSession("replacement");

		const unpublishTwo = child.publishLiveSession({
			runId: "nested-run",
			stepIndex: 2,
			session: stepTwo,
			rootSessionId: "root-session",
		});
		const unpublishZero = child.publishLiveSession({
			runId: "nested-run",
			stepIndex: 0,
			session: stepZero,
		});
		const unpublishReplacement = child.publishLiveSession({
			runId: "nested-run",
			stepIndex: 2,
			session: replacement,
		});

		assert.deepEqual(directory.sessionsForRun("nested-run"), [stepZero, replacement]);
		assert.deepEqual(released, [stepTwo], "replacement releases the previous session");
		unpublishTwo();
		assert.deepEqual(directory.sessionsForRun("nested-run"), [stepZero, replacement]);
		assert.deepEqual(released, [stepTwo], "stale unpublish does not release the replacement");
		unpublishReplacement();
		unpublishReplacement();
		assert.deepEqual(directory.sessionsForRun("nested-run"), [stepZero]);
		assert.deepEqual(released, [stepTwo, replacement]);
		unpublishZero();
		assert.deepEqual(directory.sessionsForRun("nested-run"), []);
		assert.deepEqual(released, [stepTwo, replacement, stepZero]);

		directory.dispose();
		directory.dispose();
	});

	it("stores no publication history and does not replay to late observers", async () => {
		const relay = await import("../../src/shared/live-session-relay.ts");
		const session = inertSession("already-live");
		const unpublish = relay.publishLiveSession({ runId: "run-before-observer", stepIndex: 0, session });

		const lateDirectory = new relay.LiveSessionDirectory();
		assert.deepEqual(lateDirectory.sessionsForRun("run-before-observer"), []);

		unpublish();
		lateDirectory.dispose();
	});

	it("stops observing and clears activation-owned sessions on dispose", async () => {
		const relay = await import("../../src/shared/live-session-relay.ts");
		const released: unknown[] = [];
		const directory = new relay.LiveSessionDirectory({
			handleSessionEvent: () => {},
			releaseSession: (session) => released.push(session),
		});
		const first = inertSession("first");
		const second = inertSession("second");
		const unpublishFirst = relay.publishLiveSession({ runId: "run", stepIndex: 0, session: first });
		assert.deepEqual(directory.sessionsForRun("run"), [first]);

		directory.dispose();
		assert.deepEqual(directory.sessionsForRun("run"), []);
		assert.deepEqual(released, [first]);
		const unpublishSecond = relay.publishLiveSession({ runId: "run", stepIndex: 1, session: second });
		assert.deepEqual(directory.sessionsForRun("run"), []);

		unpublishFirst();
		unpublishSecond();
	});
});
