if (process.env.NODE_ENV !== "production") {
	const husky = (await import("husky")).default;
	console.log(husky());
}
