import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as moduleApi from "node:module";

const require = moduleApi.createRequire(import.meta.url);

function resolveRuntimeModule(packageName) {
	try {
		return require.resolve(packageName);
	} catch {
		const roots = [
			join(homedir(), ".pi", "agent", "npm", "node_modules"),
			join(homedir(), ".local", "lib", "node_modules"),
			join(homedir(), ".npm-global", "lib", "node_modules"),
			"/opt/homebrew/lib/node_modules",
			"/usr/local/lib/node_modules",
		];
		for (const root of roots) {
			const packagePath = join(root, packageName, "package.json");
			if (!existsSync(packagePath)) continue;
			const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
			assert.equal(typeof metadata.main, "string", `${packageName} package main missing`);
			const modulePath = join(dirname(packagePath), metadata.main);
			assert.ok(existsSync(modulePath), `${packageName} module missing: ${modulePath}`);
			return modulePath;
		}
	}
	throw new Error(`Unable to resolve Pi runtime package: ${packageName}`);
}

const moduleUrls = {
	"@earendil-works/pi-tui": pathToFileURL(resolveRuntimeModule("@earendil-works/pi-tui")).href,
};
if (typeof moduleApi.registerHooks === "function") {
	moduleApi.registerHooks({
		resolve(specifier, context, nextResolve) {
			const url = moduleUrls[specifier];
			if (typeof url !== "string") return nextResolve(specifier, context);
			return { url, shortCircuit: true };
		},
	});
} else {
	moduleApi.register(new URL("./pi-runtime-loader.mjs", import.meta.url), {
		parentURL: import.meta.url,
		data: { moduleUrls },
	});
}

const {
	automaticRefreshAllowed,
	chromiumCookieLookupQuery,
	chromiumSafeStorageLookupArgs,
	cursorLimitsEnabled,
	formatActiveModel,
	formatCompactStatuses,
	formatLimitsSummary,
	formatProviderLines,
	formatQuotaRows,
	formatResetCountdown,
	openCodeCookieHosts,
	packFooterLine,
	packFooterLinePreserveRight,
	parseCodexWindows,
	parseCursorLimits,
	parseZenBalance,
	readBoundedResponseText,
	renderBar,
	zenLimitsEnabled,
} = await import("../sub-limits.ts");

assert.deepEqual(chromiumSafeStorageLookupArgs(), [
	"lookup",
	"application",
	"chromium",
	"xdg:schema",
	"chrome_libsecret_os_crypt_password_v2",
]);
assert.deepEqual(chromiumSafeStorageLookupArgs("chrome"), [
	"lookup",
	"application",
	"chrome",
	"xdg:schema",
	"chrome_libsecret_os_crypt_password_v2",
]);
assert.deepEqual(openCodeCookieHosts(), ["opencode.ai", ".opencode.ai"]);
const cookieQuery = chromiumCookieLookupQuery(["opencode.ai"], ["auth"], 1_000);
assert.match(cookieQuery, /path = '\/'/);
assert.match(cookieQuery, /expires_utc = 0 OR expires_utc >/);
await assert.rejects(
	readBoundedResponseText(new Response("12345"), 4),
	/response exceeds 4 bytes/,
);
await assert.rejects(
	readBoundedResponseText(new Response("ok", { headers: { "content-length": "100" } }), 4),
	/response exceeds 4 bytes/,
);
assert.equal(await readBoundedResponseText(new Response("1234"), 4), "1234");
assert.equal(automaticRefreshAllowed(0, 1_000), true);
assert.equal(automaticRefreshAllowed(1_000, 60_999), false);
assert.equal(automaticRefreshAllowed(1_000, 61_000), true);
assert.equal(automaticRefreshAllowed(61_000, 1_000), true);
assert.equal(cursorLimitsEnabled("1", false), true);
assert.equal(cursorLimitsEnabled("0", true), false);
assert.equal(cursorLimitsEnabled(null, true), true);
assert.equal(cursorLimitsEnabled(null, false), false);
assert.equal(zenLimitsEnabled("1", false), true);
assert.equal(zenLimitsEnabled("0", true), false);
assert.equal(zenLimitsEnabled(null, true), true);
assert.equal(zenLimitsEnabled(null, false), false);

assert.equal(
	parseZenBalance(
		';0x000002b9;(($R)=>$R[0]={customerID:"cus_TEST",balance:1250000000,monthlyLimit:20})($R["server-fn:test"]))',
	),
	12.5,
);
assert.equal(parseZenBalance('{"data":{"customerID":"cus_TEST","balance":750000000}}'), 7.5);
assert.equal(
	parseZenBalance(
		';(($R)=>{$R[0]={balance:9900000000};$R[1]={customerID:"cus_TEST",balance:100000000}})($R)',
	),
	1,
);
assert.equal(parseZenBalance('<span>Current balance</span><span>$3.25</span>'), 3.25);
assert.equal(parseZenBalance('{"balance":999999999}'), null);
assert.equal(parseZenBalance('Account balance $99.00'), null);

const windows = parseCodexWindows({
	plan_type: "plus",
	rate_limit: {
		primary_window: {
			used_percent: 4,
			limit_window_seconds: 604800,
			reset_at: 1784626345,
		},
		secondary_window: null,
	},
});
assert.deepEqual(windows, [
	{ label: "7d", usedPercent: 4, resetAtMs: 1784626345000 },
]);

const cursor = parseCursorLimits({
	billingCycleStart: "2026-06-29T17:37:59.000Z",
	billingCycleEnd: "2026-07-29T17:37:59.000Z",
	membershipType: "pro",
	individualUsage: {
		plan: {
			enabled: true,
			used: 2000,
			limit: 2000,
			remaining: 0,
			autoPercentUsed: 18.44,
			apiPercentUsed: 2.8444444444444446,
			totalPercentUsed: 14.84102564102564,
		},
		onDemand: {
			enabled: true,
			used: 50,
			limit: 100,
			remaining: 50,
		},
	},
});
assert.deepEqual(cursor, {
	provider: "cursor",
	short: "cursor",
	plan: "pro",
	windows: [
		{
			label: "30d",
			usedPercent: 18.44,
			resetAtMs: Date.parse("2026-07-29T17:37:59.000Z"),
		},
	],
});

assert.deepEqual(
	parseCursorLimits({
		billingCycleStart: "2026-06-29T17:37:59.000Z",
		billingCycleEnd: "2026-07-29T17:37:59.000Z",
		membershipType: "pro",
		individualUsage: {
			plan: {
				enabled: true,
				totalPercentUsed: 14.84102564102564,
				apiPercentUsed: 2.8444444444444446,
			},
		},
	}),
	{
		provider: "cursor",
		short: "cursor",
		plan: "pro",
		windows: [],
	},
);

{
	assert.equal(renderBar(0), "▁");
	assert.equal(renderBar(6), "▁");
	assert.equal(renderBar(10), "▂");
	assert.equal(renderBar(40), "▄");
	assert.equal(renderBar(100), "█");

	assert.equal(formatResetCountdown(null, 1_000), null);
	assert.equal(formatResetCountdown(900, 1_000), null);
	assert.equal(formatResetCountdown(1_000 + 45_000, 1_000), "<1m");
	assert.equal(formatResetCountdown(1_000 + 45 * 60_000, 1_000), "45m");
	assert.equal(formatResetCountdown(1_000 + 2 * 3600_000, 1_000), "2h0m");
	assert.equal(formatResetCountdown(1_000 + (5 * 3600 + 12 * 60) * 1000, 1_000), "5h12m");
	assert.equal(formatResetCountdown(1_000 + (2 * 86400 + 3 * 3600) * 1000, 1_000), "2d3h");
	assert.equal(formatResetCountdown(1_000 + 3 * 86400 * 1000, 1_000), "3d");

	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
	const lines = formatProviderLines(
		theme,
		[
			{
				provider: "openai-codex",
				short: "codex",
				plan: "plus",
				windows: [
					{ label: "5h", usedPercent: 40, resetAtMs: nowMs + 2 * 3600_000 },
					{ label: "7d", usedPercent: 6, resetAtMs: nowMs + (2 * 86400 + 3 * 3600) * 1000 },
				],
			},
			{
				provider: "cursor",
				short: "cursor",
				plan: "pro",
				windows: [{ label: "30d", usedPercent: 10, resetAtMs: nowMs + 15 * 86400_000 }],
			},
		],
		160,
		{ nowMs },
	);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^codex 5h /);
	assert.doesNotMatch(lines[0], /codex\/plus/);
	assert.doesNotMatch(lines[0], / {2}/);
	assert.doesNotMatch(lines[0], /░/);
	assert.match(lines[0], /5h ▄ 40% ↻2h0m/);
	assert.match(lines[0], / · 7d ▁ 6% ↻2d3h/);
	assert.match(lines[1], /^cursor 30d /);
	assert.doesNotMatch(lines[1], /cursor\/pro/);
	assert.doesNotMatch(lines[1], / {2}/);
	assert.match(lines[1], /30d ▂ 10% ↻15d/);

	const zenLines = formatProviderLines(
		theme,
		[{ provider: "opencode", short: "zen", windows: [], balanceUsd: 12.5 }],
		160,
	);
	assert.deepEqual(zenLines, ["zen $12.50"]);
	assert.equal(
		formatLimitsSummary([
			{ provider: "openai-codex", short: "codex", windows: [{ label: "7d", usedPercent: 6, resetAtMs: null }] },
			{ provider: "opencode", short: "zen", windows: [], balanceUsd: 12.5 },
		]),
		"codex: 7d 6% | zen: $12.50 remaining",
	);
}

{
	assert.equal(formatCompactStatuses([["domain", "domain:code (auto)"], ["route", "route:quick (auto)"]]), "code:quick");
	assert.equal(
		formatCompactStatuses([["domain", "domain:code (lock)"], ["route", "route:implement (auto)"]]),
		"code:implement lock",
	);
	assert.equal(
		formatCompactStatuses([["domain", "domain:code (auto)"], ["route", "route:investigate (lock)"]]),
		"code:investigate lock",
	);
	assert.equal(
		formatCompactStatuses([["domain", "domain:code (auto)"], ["route", "clarify:investigate (auto, q1/2)"]]),
		"code:~investigate",
	);
	assert.equal(formatCompactStatuses([["domain", "domain:off"], ["route", "route:off"]]), "off:off");

	const current = formatActiveModel("cursor", "grok-4.5:slow", [
		["cursor", "cursor-fast:off"],
		["domain", "domain:code (auto)"],
	]);
	assert.deepEqual(current, {
		label: "cursor/grok-4.5:slow",
		statuses: [["domain", "domain:code (auto)"]],
	});

	const inferred = formatActiveModel("cursor", "composer-2.5", [["cursor", "cursor-fast:on · plan"]]);
	assert.deepEqual(inferred, {
		label: "cursor/composer-2.5:fast",
		statuses: [["cursor", "plan"]],
	});

	const withEffort = formatActiveModel("openai-codex", "gpt-5.6-sol", [
		["effort", "effort:high"],
		["domain", "domain:code (auto)"],
	]);
	assert.deepEqual(withEffort, {
		label: "codex/gpt-5.6-sol:high",
		statuses: [["domain", "domain:code (auto)"]],
	});

	assert.equal(formatActiveModel("openai-codex", "gpt-5.6-sol:prio", []).label, "codex/gpt-5.6-sol:prio");
	assert.equal(packFooterLine("left", "right", 14), "left     right");
	assert.equal(packFooterLine("too-wide-left", "right", 10), null);
	const preserved = packFooterLinePreserveRight(
		"~/a/very/long/path/that/cannot/fit",
		"cursor/grok-4.5:slow",
		32,
	);
	assert.ok(preserved.endsWith("cursor/grok-4.5:slow"));

	const narrowQuotaRows = formatQuotaRows(
		{ fg: (_color, text) => text, bold: (text) => text },
		[
			{
				provider: "openai-codex",
				short: "codex",
				plan: "plus",
				windows: [{ label: "7d", usedPercent: 8, resetAtMs: null }],
			},
			{
				provider: "cursor",
				short: "cursor",
				plan: "pro",
				windows: [{ label: "30d", usedPercent: 10, resetAtMs: null }],
			},
		],
		28,
	);
	assert.equal(narrowQuotaRows.length, 2);
	assert.ok(narrowQuotaRows[0].includes("codex"));
	assert.ok(!narrowQuotaRows[0].includes("codex/plus"));
	assert.ok(narrowQuotaRows[1].includes("cursor"));
	assert.ok(!narrowQuotaRows[1].includes("cursor/pro"));
}

console.log("subscription limit parsing PASS");
