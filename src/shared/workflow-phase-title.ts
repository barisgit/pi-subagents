export const MAX_WORKFLOW_PHASES = 64;

export function hasDisplayControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
			return true;
		}
	}
	return false;
}

export function canonicalWorkflowPhaseTitle(title: string): string {
	const trimmed = title.trim();
	const stripped = trimmed.replace(/^phase\s*\d+\s*[:·-]?\s*/i, "").trim();
	return stripped.length > 0 ? stripped : trimmed;
}
