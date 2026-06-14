/**
 * Filesystem path constants for subagent runtime temp storage.
 */

import * as os from "node:os";
import * as path from "node:path";
import { resolveTempScopeId } from "../protocol/types.ts";

export const BASE_TEMP_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RUNS_DIR = path.join(BASE_TEMP_DIR, "async-subagent-runs");
export const TEMP_ARTIFACTS_DIR = path.join(BASE_TEMP_DIR, "artifacts");
