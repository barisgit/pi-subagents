import {
	canonicalWorkflowPhaseTitle,
	hasDisplayControlCharacters,
	MAX_WORKFLOW_PHASES,
} from "../shared/workflow-phase-title.ts";

export interface WorkflowPhaseMeta {
	title: string;
	detail?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	phases: WorkflowPhaseMeta[];
}

export type WorkflowMetaParseResult = { ok: true; value: WorkflowMeta } | { ok: false; reason: string };

function displayString(value: unknown, field: string): { ok: true; value: string } | { ok: false; reason: string } {
	if (typeof value !== "string") {
		return { ok: false, reason: `${field} must be a non-empty string` };
	}
	if (hasDisplayControlCharacters(value)) {
		return { ok: false, reason: `${field} must not contain control characters` };
	}
	const normalized = value.trim();
	if (!normalized) return { ok: false, reason: `${field} must be a non-empty string` };
	return { ok: true, value: normalized };
}

export function parseWorkflowMeta(value: unknown): WorkflowMetaParseResult {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, reason: "meta(value) expects an object" };
		}
		const parsedName = displayString(Reflect.get(value, "name"), "meta.name");
		if (!parsedName.ok) return parsedName;
		const parsedDescription = displayString(Reflect.get(value, "description"), "meta.description");
		if (!parsedDescription.ok) return parsedDescription;
		const rawPhases = Reflect.get(value, "phases");
		if (!Array.isArray(rawPhases)) return { ok: false, reason: "meta.phases must be an array" };
		if (rawPhases.length > MAX_WORKFLOW_PHASES) {
			return { ok: false, reason: `meta.phases must contain at most ${MAX_WORKFLOW_PHASES} entries` };
		}

		const phases: WorkflowPhaseMeta[] = [];
		const titles = new Set<string>();
		for (let index = 0; index < rawPhases.length; index += 1) {
			const rawPhase = rawPhases[index];
			if (rawPhase === null || typeof rawPhase !== "object" || Array.isArray(rawPhase)) {
				return { ok: false, reason: `meta.phases[${index}] must be an object` };
			}
			const parsedTitle = displayString(Reflect.get(rawPhase, "title"), `meta.phases[${index}].title`);
			if (!parsedTitle.ok) return parsedTitle;
			const title = canonicalWorkflowPhaseTitle(parsedTitle.value);
			if (titles.has(title)) return { ok: false, reason: `meta phase title '${title}' must be unique` };
			titles.add(title);
			const rawDetail = Reflect.get(rawPhase, "detail");
			if (rawDetail === undefined) {
				phases.push({ title });
				continue;
			}
			const parsedDetail = displayString(rawDetail, `meta.phases[${index}].detail`);
			if (!parsedDetail.ok) return parsedDetail;
			phases.push({ title, detail: parsedDetail.value });
		}

		return {
			ok: true,
			value: { name: parsedName.value, description: parsedDescription.value, phases },
		};
	} catch {
		return { ok: false, reason: "meta(value) could not be read" };
	}
}
