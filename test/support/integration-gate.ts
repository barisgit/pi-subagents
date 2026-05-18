export function asyncIntegrationSkipReason(env: NodeJS.ProcessEnv, jitiAvailable: boolean): string | undefined {
	if (env.PI_RUN_ASYNC_INTEGRATION !== "1") {
		return "detached-child async tests disabled (set PI_RUN_ASYNC_INTEGRATION=1 to enable)";
	}
	if (!jitiAvailable) return "jiti not available";
	return undefined;
}
