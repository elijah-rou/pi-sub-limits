let moduleUrls = Object.freeze({});

export function initialize(data) {
	if (!data || typeof data !== "object") throw new Error("Pi runtime loader data missing");
	if (!data.moduleUrls || typeof data.moduleUrls !== "object") throw new Error("Pi runtime module URLs missing");
	moduleUrls = Object.freeze({ ...data.moduleUrls });
}

export async function resolve(specifier, context, nextResolve) {
	const url = moduleUrls[specifier];
	if (typeof url !== "string") return nextResolve(specifier, context);
	return { url, shortCircuit: true };
}
