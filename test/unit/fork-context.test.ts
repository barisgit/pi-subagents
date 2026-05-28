import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForkContextResolver, resolveSubagentContext } from "../../fork-context.ts";

function manager(overrides: Record<string, unknown>) {
	return overrides as unknown as Parameters<typeof createForkContextResolver>[0];
}

describe("resolveSubagentContext", () => {
	it("defaults to fresh", () => {
		assert.equal(resolveSubagentContext(undefined), "fresh");
		assert.equal(resolveSubagentContext("anything"), "fresh");
	});

	it("accepts fork", () => {
		assert.equal(resolveSubagentContext("fork"), "fork");
	});
});

describe("createForkContextResolver", () => {
	it("fresh mode never calls createBranchedSession", () => {
		let calls = 0;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-123",
			constructor: { open: () => ({ createBranchedSession: () => { calls++; return "/tmp/child.jsonl"; } }) },
		}), "fresh");

		assert.equal(resolver.sessionFileForIndex(0), undefined);
		assert.equal(calls, 0);
	});

	it("fails fast when parent session file is missing", () => {
		assert.throws(
			() => createForkContextResolver(manager({
				getSessionFile: () => undefined,
				getLeafId: () => "leaf-123",
				constructor: { open: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) },
			}), "fork"),
			/Forked subagent context requires a persisted parent session\./,
		);
	});

	it("fails fast when leaf id is missing", () => {
		assert.throws(
			() => createForkContextResolver(manager({
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => null,
				constructor: { open: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) },
			}), "fork"),
			/Forked subagent context requires a current leaf to fork from\./,
		);
	});

	it("opens a throwaway manager from the persisted parent session file", () => {
		const openedPaths: string[] = [];
		const seenLeafIds: string[] = [];
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-xyz",
			createBranchedSession: () => { throw new Error("live manager should not branch"); },
			constructor: {
				open: (sessionFile: string) => {
					openedPaths.push(sessionFile);
					return { createBranchedSession: (leafId: string) => { seenLeafIds.push(leafId); return `/tmp/child-${seenLeafIds.length}.jsonl`; } };
				},
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		resolver.sessionFileForIndex(1);
		resolver.sessionFileForIndex(2);

		assert.deepEqual(openedPaths, ["/tmp/parent.jsonl", "/tmp/parent.jsonl", "/tmp/parent.jsonl"]);
		assert.deepEqual(seenLeafIds, ["leaf-xyz", "leaf-xyz", "leaf-xyz"]);
	});

	it("creates isolated branched sessions per index (parallel and chain compatible)", () => {
		let count = 0;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: { open: () => ({ createBranchedSession: () => { count++; return `/tmp/fork-${count}.jsonl`; } }) },
		}), "fork");

		const singleSession = resolver.sessionFileForIndex(0);
		const parallelSessions = [resolver.sessionFileForIndex(1), resolver.sessionFileForIndex(2)];
		const chainSessions = [resolver.sessionFileForIndex(3), resolver.sessionFileForIndex(4)];

		assert.equal(singleSession, "/tmp/fork-1.jsonl");
		assert.deepEqual(parallelSessions, ["/tmp/fork-2.jsonl", "/tmp/fork-3.jsonl"]);
		assert.deepEqual(chainSessions, ["/tmp/fork-4.jsonl", "/tmp/fork-5.jsonl"]);
		assert.equal(count, 5);
	});

	it("memoizes per index to keep behavior deterministic", () => {
		let calls = 0;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: { open: () => ({ createBranchedSession: () => { calls++; return `/tmp/fork-${calls}.jsonl`; } }) },
		}), "fork");

		const first = resolver.sessionFileForIndex(7);
		const second = resolver.sessionFileForIndex(7);
		assert.equal(first, second);
		assert.equal(calls, 1);
	});

	it("does not silently fallback to fresh when branch extraction fails", () => {
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: { open: () => ({ createBranchedSession: () => undefined }) },
		}), "fork");

		assert.throws(
			() => resolver.sessionFileForIndex(0),
			/Failed to create forked subagent session: Session manager did not return a session file\./,
		);
	});

	it("walks back past the dispatching subagent tool_use so child does not inherit an orphan tool_use", () => {
		const seenLeafIds: string[] = [];
		const entries = {
			"assistant-leaf": {
				type: "message",
				id: "assistant-leaf",
				parentId: "user-prompt",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "" },
						{ type: "toolCall", id: "call_1", name: "subagent", arguments: { run: [] } },
					],
				},
			},
			"user-prompt": {
				type: "message",
				id: "user-prompt",
				parentId: "session-header",
				message: { role: "user", content: [{ type: "text", text: "go" }] },
			},
		} as const;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "assistant-leaf",
			getEntry: (id: string) => entries[id as keyof typeof entries],
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return `/tmp/child-${seenLeafIds.length}.jsonl`;
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["user-prompt"]);
	});

	it("does not walk back when the leaf assistant turn has no subagent tool_use", () => {
		const seenLeafIds: string[] = [];
		const entries = {
			"assistant-leaf": {
				type: "message",
				id: "assistant-leaf",
				parentId: "user-prompt",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hi" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } },
					],
				},
			},
		} as const;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "assistant-leaf",
			getEntry: (id: string) => entries[id as keyof typeof entries],
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return "/tmp/child.jsonl";
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["assistant-leaf"]);
	});

	it("does not walk back when the leaf is a user message", () => {
		const seenLeafIds: string[] = [];
		const entries = {
			"user-leaf": {
				type: "message",
				id: "user-leaf",
				parentId: "session-header",
				message: { role: "user", content: [{ type: "text", text: "go" }] },
			},
		} as const;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "user-leaf",
			getEntry: (id: string) => entries[id as keyof typeof entries],
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return "/tmp/child.jsonl";
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["user-leaf"]);
	});

	it("falls back to original leafId when getEntry is unavailable", () => {
		const seenLeafIds: string[] = [];
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-xyz",
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return "/tmp/child.jsonl";
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["leaf-xyz"]);
	});

	it("falls back to original leafId when getEntry throws", () => {
		const seenLeafIds: string[] = [];
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-xyz",
			getEntry: () => { throw new Error("boom"); },
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return "/tmp/child.jsonl";
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["leaf-xyz"]);
	});

	it("falls back to original leafId when the dispatching assistant has no parentId", () => {
		const seenLeafIds: string[] = [];
		const entries = {
			"assistant-leaf": {
				type: "message",
				id: "assistant-leaf",
				parentId: null,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "subagent", arguments: {} }],
				},
			},
		} as const;
		const resolver = createForkContextResolver(manager({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "assistant-leaf",
			getEntry: (id: string) => entries[id as keyof typeof entries],
			constructor: {
				open: () => ({
					createBranchedSession: (leafId: string) => {
						seenLeafIds.push(leafId);
						return "/tmp/child.jsonl";
					},
				}),
			},
		}), "fork");

		resolver.sessionFileForIndex(0);
		assert.deepEqual(seenLeafIds, ["assistant-leaf"]);
	});
});
