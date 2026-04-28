import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTopLevelTasks } from "../../subagent-executor.ts";

describe("normalizeTopLevelTasks", () => {
	it("uses top-level agent for string task shorthand", () => {
		const result = normalizeTopLevelTasks({ agent: "explorer", tasks: ["auth", "API"] });
		assert.deepEqual(result.tasks, [
			{ agent: "explorer", task: "auth" },
			{ agent: "explorer", task: "API" },
		]);
	});

	it("uses top-level agent for task objects that omit agent", () => {
		const result = normalizeTopLevelTasks({
			agent: "explorer",
			tasks: [{ task: "auth" }, { task: "API", model: "provider/model" }],
		});
		assert.deepEqual(result.tasks, [
			{ agent: "explorer", task: "auth" },
			{ agent: "explorer", task: "API", model: "provider/model" },
		]);
	});

	it("keeps per-task agents over top-level defaults", () => {
		const result = normalizeTopLevelTasks({
			agent: "explorer",
			tasks: [{ agent: "reviewer", task: "auth" }],
		});
		assert.deepEqual(result.tasks, [{ agent: "reviewer", task: "auth" }]);
	});

	it("rejects string shorthand without top-level agent", () => {
		const result = normalizeTopLevelTasks({ tasks: ["auth"] });
		assert.equal(result.error, "tasks[0] string shorthand requires top-level agent");
	});

	it("rejects object shorthand without top-level agent", () => {
		const result = normalizeTopLevelTasks({ tasks: [{ task: "auth" }] });
		assert.equal(result.error, "tasks[0].agent is required when top-level agent is not set");
	});
});
