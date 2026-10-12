import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { cleanupOldArtifacts } from "../../src/shared/artifacts.ts";

it("best-effort artifact cleanup contains scan and marker-write failures", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-cleanup-"));
	try {
		const marker = path.join(dir, ".last-cleanup");
		fs.mkdirSync(marker);
		fs.utimesSync(marker, new Date(0), new Date(0));
		assert.doesNotThrow(() => cleanupOldArtifacts(dir, 1));
		const notDirectory = path.join(dir, "file");
		fs.writeFileSync(notDirectory, "not a directory");
		assert.doesNotThrow(() => cleanupOldArtifacts(notDirectory, 1));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
