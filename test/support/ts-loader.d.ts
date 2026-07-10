declare module "../support/ts-loader.mjs" {
	export function resolve(
		specifier: string,
		context: { parentURL?: string },
		nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
	): unknown;
}
