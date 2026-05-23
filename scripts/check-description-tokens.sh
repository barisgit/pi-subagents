#!/usr/bin/env bash
# check-description-tokens.sh — assert the registered subagent tool description
# fits the cl100k_base token budget used by the charter.

set -euo pipefail

node --experimental-strip-types --input-type=module <<'NODE'
import { descriptionTokenCheck, readRegisteredSubagentDescription } from "./lib/count-tokens.ts";

const result = descriptionTokenCheck(readRegisteredSubagentDescription());
const message = `description tokens: ${result.count}/${result.limit}`;

if (!result.ok) {
	console.error(`${message} (over limit)`);
	process.exit(1);
}

console.log(`${message} (within limit)`);
NODE
