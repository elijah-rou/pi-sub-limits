/**
 * Subscription limit bars and prepaid balances in the footer for auth'd providers.
 *
 * Layout (top → bottom):
 *   pwd
 *   token/context stats
 *   per-provider quotas       ← this extension
 *   model settings
 *   extension statuses
 */

import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const AUTH_PATH = join(process.env.HOME || homedir(), ".pi", "agent", "auth.json");
const CURSOR_LIMITS_MARKER_PATH = join(
	process.env.HOME || homedir(),
	".pi",
	"agent",
	"cursor-limits.enabled",
);
const ZEN_LIMITS_MARKER_PATH = join(
	process.env.HOME || homedir(),
	".pi",
	"agent",
	"zen-limits.enabled",
);
const POLL_MS = 60_000;
const GAUGE_GLYPHS = "▁▂▃▄▅▆▇█";
const MAX_AUTH_PROVIDERS = 8;
const MAX_PROVIDERS = 10;
const REQUEST_TIMEOUT_MS = 10_000;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary";
const CURSOR_COOKIE_HOST = "cursor.com";
const CURSOR_COOKIE_NAME = "WorkosCursorSessionToken";

const OPENCODE_BASE_URL = "https://opencode.ai";
const OPENCODE_WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const OPENCODE_BILLING_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const OPENCODE_COOKIE_HOSTS = ["opencode.ai", ".opencode.ai", "app.opencode.ai", ".app.opencode.ai"];
const OPENCODE_COOKIE_NAMES = ["auth", "__Host-auth"];
const OPENCODE_USD_SCALE = 100_000_000;
const OPENCODE_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const CHROMIUM_SAFE_STORAGE_APPLICATION = "chromium";
const CHROMIUM_SAFE_STORAGE_SCHEMA = "chrome_libsecret_os_crypt_password_v2";
const CHROMIUM_COOKIE_DATABASES = [
	join(process.env.HOME || homedir(), ".config", "net.imput.helium", "Default", "Cookies"),
	join(process.env.HOME || homedir(), ".config", "chromium", "Default", "Cookies"),
	join(process.env.HOME || homedir(), ".config", "google-chrome", "Default", "Cookies"),
];
const exec = promisify(execFile);

type OAuthCred = {
	type: "oauth";
	access: string;
	expires: number;
	accountId?: string;
	[key: string]: unknown;
};

type AuthFile = Record<
	string,
	{ type?: string; key?: string; access?: string; refresh?: string; expires?: number; accountId?: string }
>;

type LimitWindow = {
	label: string;
	usedPercent: number;
	resetAtMs: number | null;
};

type ProviderLimits = {
	provider: string;
	short: string;
	plan?: string;
	windows: LimitWindow[];
	balanceUsd?: number;
	error?: string;
};

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

let cached: ProviderLimits[] = [];
let requestRender: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | undefined;

export function clampPercent(value: number): number {
	assertFinite(value, "percent");
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

export function windowLabel(limitWindowSeconds: number | null | undefined): string {
	if (limitWindowSeconds == null || !Number.isFinite(limitWindowSeconds) || limitWindowSeconds <= 0) {
		return "win";
	}
	const hours = Math.round(limitWindowSeconds / 3600);
	if (hours === 5) return "5h";
	if (hours === 24) return "1d";
	if (hours === 168) return "7d";
	if (hours % 24 === 0) return `${hours / 24}d`;
	return `${hours}h`;
}

/** Single vertical-fill glyph for usage percent. */
export function renderBar(usedPercent: number): string {
	const pct = clampPercent(usedPercent);
	const last = GAUGE_GLYPHS.length - 1;
	assert(last >= 1, "gauge glyph set too small");
	const index = Math.round((pct / 100) * last);
	assert(index >= 0 && index <= last, "gauge index out of bounds");
	const glyph = GAUGE_GLYPHS[index];
	assert(glyph != null && glyph.length === 1, "missing gauge glyph");
	return glyph;
}

/** Compact remaining time until reset; null when unknown or already reset. */
export function formatResetCountdown(resetAtMs: number | null | undefined, nowMs = Date.now()): string | null {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) return null;
	assertFinite(nowMs, "nowMs");
	const remainingMs = resetAtMs - nowMs;
	if (remainingMs <= 0) return null;
	const totalSeconds = Math.floor(remainingMs / 1000);
	if (totalSeconds < 60) return "<1m";
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 24) return `${totalHours}h${minutes}m`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}

export function formatTokens(count: number): string {
	assertFinite(count, "token count");
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertFinite(value: number, label: string): void {
	assert(typeof value === "number" && Number.isFinite(value), `${label} must be finite`);
}

function colorForPercent(theme: ThemeLike, pct: number, text: string): string {
	if (pct > 90) return theme.fg("error", text);
	if (pct > 70) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function optionalBrowserLimitsEnabled(
	environmentValue: string | null | undefined,
	markerExists: boolean,
): boolean {
	if (environmentValue != null && environmentValue.length > 0) return environmentValue === "1";
	return markerExists;
}

export function cursorLimitsEnabled(
	environmentValue: string | null | undefined = process.env.PI_SUB_LIMITS_CURSOR,
	markerExists = existsSync(CURSOR_LIMITS_MARKER_PATH),
): boolean {
	return optionalBrowserLimitsEnabled(environmentValue, markerExists);
}

export function zenLimitsEnabled(
	environmentValue: string | null | undefined = process.env.PI_SUB_LIMITS_ZEN,
	markerExists = existsSync(ZEN_LIMITS_MARKER_PATH),
): boolean {
	return optionalBrowserLimitsEnabled(environmentValue, markerExists);
}

function readAuth(): AuthFile {
	if (!existsSync(AUTH_PATH)) return {};
	const raw = readFileSync(AUTH_PATH, "utf8");
	assert(raw.length > 0, "auth.json empty");
	const parsed = JSON.parse(raw) as AuthFile;
	assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), "auth.json invalid");
	return parsed;
}

function asOAuth(_provider: string, cred: AuthFile[string] | undefined): OAuthCred | undefined {
	if (!cred || cred.type !== "oauth") return undefined;
	if (typeof cred.access !== "string" || cred.access.length === 0) return undefined;
	if (typeof cred.expires !== "number" || !Number.isFinite(cred.expires)) return undefined;
	return {
		type: "oauth",
		access: cred.access,
		expires: cred.expires,
		accountId: typeof cred.accountId === "string" ? cred.accountId : undefined,
	};
}

function decodeCodexAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length < 2) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
		};
		const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

async function fetchCodexLimits(cred: OAuthCred): Promise<ProviderLimits> {
	const accountId = cred.accountId ?? decodeCodexAccountId(cred.access);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cred.access}`,
		Accept: "application/json",
		"User-Agent": "pi-sub-limits/1.0",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	const response = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (response.status === 401 || response.status === 403) {
		throw new Error("codex OAuth token expired; sign in again");
	}
	if (!response.ok) throw new Error(`codex usage ${response.status}`);

	const data = (await response.json()) as CodexUsageResponse;
	return {
		provider: "openai-codex",
		short: "codex",
		plan: typeof data.plan_type === "string" ? data.plan_type : undefined,
		windows: parseCodexWindows(data),
	};
}

type CodexWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
};

type CodexUsageResponse = {
	plan_type?: string;
	rate_limit?: {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	};
};

export function parseCodexWindows(data: CodexUsageResponse): LimitWindow[] {
	const windows: LimitWindow[] = [];
	pushCodexWindow(windows, data.rate_limit?.primary_window);
	pushCodexWindow(windows, data.rate_limit?.secondary_window);
	assert(windows.length <= 4, "too many codex windows");

	const order = new Map([
		["5h", 0],
		["7d", 1],
	]);
	windows.sort((a, b) => (order.get(a.label) ?? 2) - (order.get(b.label) ?? 2));
	return windows;
}

function pushCodexWindow(windows: LimitWindow[], window: CodexWindow | null | undefined): void {
	if (!window || typeof window.used_percent !== "number") return;
	windows.push({
		label: windowLabel(window.limit_window_seconds),
		usedPercent: clampPercent(window.used_percent),
		resetAtMs: typeof window.reset_at === "number" ? window.reset_at * 1000 : null,
	});
}

async function fetchAnthropicLimits(cred: OAuthCred): Promise<ProviderLimits> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cred.access}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"anthropic-beta": "oauth-2025-04-20",
		"User-Agent": "pi-sub-limits/1.0",
	};

	const response = await fetch(ANTHROPIC_USAGE_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (response.status === 401 || response.status === 403) {
		throw new Error("anthropic OAuth token expired; sign in again");
	}
	if (!response.ok) throw new Error(`anthropic usage ${response.status}`);

	const data = (await response.json()) as {
		five_hour?: AnthropicWindow | null;
		seven_day?: AnthropicWindow | null;
		seven_day_opus?: AnthropicWindow | null;
	};

	const windows: LimitWindow[] = [];
	pushAnthropicWindow(windows, "5h", data.five_hour);
	pushAnthropicWindow(windows, "7d", data.seven_day);
	pushAnthropicWindow(windows, "opus", data.seven_day_opus);
	assert(windows.length <= 4, "too many anthropic windows");

	return { provider: "anthropic", short: "claude", windows };
}

type AnthropicWindow = {
	utilization?: number;
	resets_at?: string | null;
};

function pushAnthropicWindow(windows: LimitWindow[], label: string, window: AnthropicWindow | null | undefined): void {
	if (!window || typeof window.utilization !== "number") return;
	const resetAtMs =
		typeof window.resets_at === "string" && window.resets_at.length > 0 ? Date.parse(window.resets_at) : null;
	windows.push({
		label,
		usedPercent: clampPercent(window.utilization),
		resetAtMs: resetAtMs != null && Number.isFinite(resetAtMs) ? resetAtMs : null,
	});
}

type CursorUsageResponse = {
	billingCycleStart?: string;
	billingCycleEnd?: string;
	membershipType?: string;
	individualUsage?: {
		plan?: {
			enabled?: boolean;
			/** First-party models pool (Auto / Composer / Grok). */
			autoPercentUsed?: number;
			apiPercentUsed?: number;
			totalPercentUsed?: number;
		};
		onDemand?: {
			enabled?: boolean;
			used?: number;
			limit?: number | null;
			remaining?: number | null;
		};
	};
};

export function parseCursorLimits(data: CursorUsageResponse): ProviderLimits {
	const startAtMs = typeof data.billingCycleStart === "string" ? Date.parse(data.billingCycleStart) : Number.NaN;
	const resetAtMs = typeof data.billingCycleEnd === "string" ? Date.parse(data.billingCycleEnd) : Number.NaN;
	const durationSeconds =
		Number.isFinite(startAtMs) && Number.isFinite(resetAtMs) && resetAtMs > startAtMs
			? (resetAtMs - startAtMs) / 1000
			: undefined;
	const usedPercent = data.individualUsage?.plan?.autoPercentUsed;
	const windows: LimitWindow[] = [];
	if (data.individualUsage?.plan?.enabled && typeof usedPercent === "number") {
		windows.push({
			label: windowLabel(durationSeconds),
			usedPercent: clampPercent(usedPercent),
			resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
		});
	}
	return {
		provider: "cursor",
		short: "cursor",
		plan: typeof data.membershipType === "string" ? data.membershipType : undefined,
		windows,
	};
}

type ChromiumCookie = { name: string; value: string };

function sqlLiteralList(values: string[]): string {
	assert(values.length > 0 && values.length <= 8, "cookie query value count out of bounds");
	for (const value of values) {
		assert(/^[A-Za-z0-9._-]+$/.test(value), "unsafe cookie query value");
	}
	return values.map((value) => `'${value}'`).join(", ");
}

async function readChromiumCookie(hosts: string[], names: string[]): Promise<ChromiumCookie> {
	const query =
		`SELECT hex(host_key) || '|' || hex(name) || '|' || hex(value) || '|' || hex(encrypted_value) ` +
		`FROM cookies WHERE host_key IN (${sqlLiteralList(hosts)}) AND name IN (${sqlLiteralList(names)}) ` +
		"ORDER BY last_access_utc DESC LIMIT 1;";
	let lastError: unknown;

	for (const database of CHROMIUM_COOKIE_DATABASES) {
		if (!existsSync(database)) continue;
		try {
			const { stdout } = await exec("sqlite3", ["-readonly", database, query], {
				timeout: 5_000,
				maxBuffer: 16_384,
			});
			const row = stdout.trim();
			if (!row) continue;
			const fields = row.split("|");
			assert(fields.length === 4, "Chromium cookie row malformed");
			const [hostHex, nameHex, plainHex, encryptedHex] = fields;
			assert(hostHex && nameHex, "Chromium cookie identity missing");
			const host = Buffer.from(hostHex, "hex").toString("utf8");
			const name = Buffer.from(nameHex, "hex").toString("utf8");
			const value = plainHex
				? Buffer.from(plainHex, "hex").toString("utf8")
				: encryptedHex
					? decryptChromiumCookie(host, encryptedHex, await readChromiumSafeStoragePassword())
					: "";
			assert(value.length > 0, "Chromium cookie value empty");
			assert(!value.includes("\n"), "Chromium cookie contains newline");
			return { name, value };
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError instanceof Error) throw lastError;
	throw new Error("Chromium browser session not found");
}

async function readCursorSessionCookie(): Promise<string> {
	return (await readChromiumCookie([CURSOR_COOKIE_HOST], [CURSOR_COOKIE_NAME])).value;
}

export function chromiumSafeStorageLookupArgs(): string[] {
	return [
		"lookup",
		"application",
		CHROMIUM_SAFE_STORAGE_APPLICATION,
		"xdg:schema",
		CHROMIUM_SAFE_STORAGE_SCHEMA,
	];
}

async function readChromiumSafeStoragePassword(): Promise<string> {
	const { stdout } = await exec("secret-tool", chromiumSafeStorageLookupArgs(), {
		timeout: 5_000,
		maxBuffer: 4_096,
	});
	const password = stdout.trimEnd();
	assert(password.length > 0, "Chromium Safe Storage password missing");
	return password;
}

function decryptChromiumCookie(host: string, encryptedHex: string, password: string): string {
	const encrypted = Buffer.from(encryptedHex, "hex");
	assert(encrypted.length > 19, "Chromium cookie ciphertext too short");
	const version = encrypted.subarray(0, 3).toString("ascii");
	assert(version === "v10" || version === "v11", `unsupported Chromium cookie version: ${version}`);
	const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
	const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
	let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
	const hostHash = createHash("sha256").update(host).digest();
	if (plain.subarray(0, hostHash.length).equals(hostHash)) plain = plain.subarray(hostHash.length);
	const cookie = plain.toString("utf8");
	assert(cookie.length > 0, "Chromium cookie decrypted empty");
	assert(!cookie.includes("\n"), "Chromium cookie contains newline");
	return cookie;
}

async function fetchCursorLimits(): Promise<ProviderLimits> {
	const sessionCookie = await readCursorSessionCookie();
	const response = await fetch(CURSOR_USAGE_URL, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Accept: "application/json",
			Cookie: `${CURSOR_COOKIE_NAME}=${sessionCookie}`,
			"User-Agent": "pi-sub-limits/1.0",
		},
	});
	if (!response.ok) throw new Error(`cursor usage ${response.status}`);
	return parseCursorLimits((await response.json()) as CursorUsageResponse);
}

function finiteNumber(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim().length > 0
				? Number(value.replaceAll(",", "").trim())
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function findZenRawBalance(value: unknown): number | null {
	const queue: unknown[] = [value];
	const maxNodes = 2_048;
	for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
		const current = queue[index];
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (const child of current) {
				if (queue.length >= maxNodes) return null;
				queue.push(child);
			}
			continue;
		}

		const record = current as Record<string, unknown>;
		if (typeof record.customerID === "string" && record.customerID.length > 0) {
			const balance = finiteNumber(record.balance);
			if (balance != null) return balance;
		}
		for (const child of Object.values(record)) {
			if (queue.length >= maxNodes) return null;
			queue.push(child);
		}
	}
	return null;
}

function parseDollarAmount(raw: string): number | null {
	const value = finiteNumber(raw);
	return value != null && value >= 0 ? value : null;
}

export function parseZenBalance(text: string): number | null {
	assert(typeof text === "string", "Zen balance payload must be text");
	if (text.length === 0) return null;

	try {
		const rawBalance = findZenRawBalance(JSON.parse(text));
		if (rawBalance != null) return rawBalance / OPENCODE_USD_SCALE;
	} catch {
		// SolidStart server-function responses are JavaScript rather than JSON.
	}

	const customerPattern = /(?:^|[,{])\s*(?:"customerID"|customerID)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?"[^"]+"/m;
	const balancePattern = /(?:^|[,{])\s*(?:"balance"|balance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/m;
	if (customerPattern.test(text)) {
		const balance = balancePattern.exec(text);
		const rawBalance = finiteNumber(balance?.[1]);
		if (rawBalance != null) return rawBalance / OPENCODE_USD_SCALE;
	}

	const afterLabel = /(?:current\s+balance|zen\s+balance|現在の残高)[\s\S]{0,160}?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(
		text,
	);
	if (afterLabel?.[1]) return parseDollarAmount(afterLabel[1]);
	const beforeLabel = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)[\s\S]{0,160}?(?:current\s+balance|zen\s+balance|現在の残高)/i.exec(
		text,
	);
	return beforeLabel?.[1] ? parseDollarAmount(beforeLabel[1]) : null;
}

function parseOpenCodeWorkspaceIds(text: string): string[] {
	const matches = text.match(/wrk_[A-Za-z0-9]+/g) ?? [];
	return [...new Set(matches)].slice(0, 32);
}

function normalizeOpenCodeWorkspace(raw: string | undefined): string | null {
	if (!raw) return null;
	const match = /(?:^|\/)(wrk_[A-Za-z0-9]+)(?:\/|$)/.exec(raw.trim()) ?? /(wrk_[A-Za-z0-9]+)/.exec(raw);
	return match?.[1] ?? null;
}

async function fetchOpenCodeText(url: string, cookieHeader: string, headers?: Record<string, string>): Promise<string> {
	const response = await fetch(url, {
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Accept: "text/html, text/javascript, application/json;q=0.9, */*;q=0.8",
			Cookie: cookieHeader,
			"User-Agent": OPENCODE_USER_AGENT,
			...headers,
		},
	});
	if (response.status >= 300 && response.status < 400) throw new Error("OpenCode dashboard login expired");
	if (response.status === 401 || response.status === 403) throw new Error("OpenCode dashboard login expired");
	if (!response.ok) throw new Error(`OpenCode dashboard ${response.status}`);
	return response.text();
}

async function fetchOpenCodeServerText(
	serverId: string,
	cookieHeader: string,
	referer: string,
	args?: string,
): Promise<string> {
	const url = new URL(`${OPENCODE_BASE_URL}/_server`);
	url.searchParams.set("id", serverId);
	if (args) url.searchParams.set("args", args);
	return fetchOpenCodeText(url.toString(), cookieHeader, {
		Origin: OPENCODE_BASE_URL,
		Referer: referer,
		"X-Server-Id": serverId,
		"X-Server-Instance": `server-fn:${randomUUID()}`,
	});
}

async function readOpenCodeCookieHeader(): Promise<string> {
	const cookie = await readChromiumCookie(OPENCODE_COOKIE_HOSTS, OPENCODE_COOKIE_NAMES);
	return `${cookie.name}=${cookie.value}`;
}

async function resolveOpenCodeWorkspace(cookieHeader: string): Promise<string> {
	const override = normalizeOpenCodeWorkspace(process.env.PI_SUB_LIMITS_ZEN_WORKSPACE);
	if (override) return override;

	const homeText = await fetchOpenCodeText(OPENCODE_BASE_URL, cookieHeader);
	const pageIds = parseOpenCodeWorkspaceIds(homeText);
	if (pageIds[0]) return pageIds[0];

	const serverText = await fetchOpenCodeServerText(
		OPENCODE_WORKSPACES_SERVER_ID,
		cookieHeader,
		OPENCODE_BASE_URL,
	);
	const serverIds = parseOpenCodeWorkspaceIds(serverText);
	if (serverIds[0]) return serverIds[0];
	throw new Error("OpenCode workspace not found");
}

async function fetchZenLimits(): Promise<ProviderLimits> {
	const cookieHeader = await readOpenCodeCookieHeader();
	const workspaceId = await resolveOpenCodeWorkspace(cookieHeader);
	const dashboardUrl = `${OPENCODE_BASE_URL}/workspace/${workspaceId}`;
	const dashboardText = await fetchOpenCodeText(dashboardUrl, cookieHeader);
	let balanceUsd = parseZenBalance(dashboardText);
	if (balanceUsd == null) {
		const billingText = await fetchOpenCodeServerText(
			OPENCODE_BILLING_SERVER_ID,
			cookieHeader,
			dashboardUrl,
			JSON.stringify([workspaceId]),
		);
		balanceUsd = parseZenBalance(billingText);
	}
	if (balanceUsd == null) throw new Error("OpenCode Zen balance unavailable");
	assertFinite(balanceUsd, "Zen balance");
	return { provider: "opencode", short: "zen", windows: [], balanceUsd };
}

export async function loadAllLimits(): Promise<ProviderLimits[]> {
	const auth = readAuth();
	const providers = Object.keys(auth).filter((id) => auth[id]?.type === "oauth").slice(0, MAX_AUTH_PROVIDERS);
	const out: ProviderLimits[] = [];

	for (const provider of providers) {
		const cred = asOAuth(provider, auth[provider]);
		if (!cred) continue;

		if (provider === "openai-codex") {
			try {
				out.push(await fetchCodexLimits(cred));
			} catch (error) {
				out.push({
					provider,
					short: "codex",
					windows: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}

		if (provider === "anthropic") {
			try {
				out.push(await fetchAnthropicLimits(cred));
			} catch (error) {
				out.push({
					provider,
					short: "claude",
					windows: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	if (auth.cursor && cursorLimitsEnabled()) {
		try {
			out.push(await fetchCursorLimits());
		} catch {
			out.push({
				provider: "cursor",
				short: "cursor",
				windows: [],
				error: "dashboard session unavailable",
			});
		}
	}

	if (auth.opencode && zenLimitsEnabled()) {
		try {
			out.push(await fetchZenLimits());
		} catch (error) {
			out.push({
				provider: "opencode",
				short: "zen",
				windows: [],
				error: error instanceof Error ? error.message : "dashboard session unavailable",
			});
		}
	}

	assert(out.length <= MAX_PROVIDERS, "too many loaded providers");
	return out;
}

function providerName(limits: ProviderLimits): string {
	return limits.short;
}

export function formatProviderLine(
	theme: ThemeLike,
	limits: ProviderLimits,
	width: number,
	options?: { nowMs?: number },
): string {
	assert(width > 0, "width must be positive");
	const name = providerName(limits);
	const nowMs = options?.nowMs ?? Date.now();

	if (limits.error) {
		return truncateToWidth(
			theme.fg("warning", `${name} limits: ${limits.error}`),
			width,
			theme.fg("dim", "..."),
		);
	}
	if (limits.balanceUsd != null) {
		assertFinite(limits.balanceUsd, "balanceUsd");
		const amount = limits.balanceUsd < 0
			? `-$${Math.abs(limits.balanceUsd).toFixed(2)}`
			: `$${limits.balanceUsd.toFixed(2)}`;
		return truncateToWidth(
			theme.fg("dim", `${name} ${amount} remaining`),
			width,
			theme.fg("dim", "..."),
		);
	}
	if (limits.windows.length === 0) {
		return truncateToWidth(
			theme.fg("dim", `${name} limits: n/a`),
			width,
			theme.fg("dim", "..."),
		);
	}

	const parts = limits.windows.map((window) => {
		const bar = renderBar(window.usedPercent);
		const colored = colorForPercent(theme, window.usedPercent, `${bar} ${Math.round(window.usedPercent)}%`);
		const reset = formatResetCountdown(window.resetAtMs, nowMs);
		const resetPart = reset ? ` ${theme.fg("dim", `↻${reset}`)}` : "";
		return `${theme.fg("dim", window.label)} ${colored}${resetPart}`;
	});

	const line = `${theme.fg("dim", name)} ${parts.join(theme.fg("dim", " · "))}`;
	return truncateToWidth(line, width, theme.fg("dim", "..."));
}

export function formatProviderLines(
	theme: ThemeLike,
	allLimits: ProviderLimits[],
	width: number,
	options?: { nowMs?: number },
): string[] {
	assert(width > 0, "width must be positive");
	assert(Array.isArray(allLimits), "allLimits must be array");
	assert(allLimits.length <= MAX_PROVIDERS, "too many providers");

	return allLimits.map((limits) =>
		formatProviderLine(theme, limits, width, {
			nowMs: options?.nowMs,
		}),
	);
}

export function formatQuotaRows(
	theme: ThemeLike,
	allLimits: ProviderLimits[],
	width: number,
	options?: { nowMs?: number },
): string[] {
	assert(width > 0, "width must be positive");
	const providerLines = formatProviderLines(theme, allLimits, 10_000, options);
	if (providerLines.length === 0) return [];
	const combined = providerLines.join(theme.fg("dim", " │ "));
	if (visibleWidth(combined) <= width) return [combined];
	return formatProviderLines(theme, allLimits, width, options);
}

export function formatLimitsSummary(allLimits: ProviderLimits[]): string {
	assert(Array.isArray(allLimits), "allLimits must be array");
	assert(allLimits.length <= MAX_PROVIDERS, "too many providers");
	if (allLimits.length === 0) return "No auth'd subscription limits or balances found";
	return allLimits
		.map((item) => {
			if (item.error) return `${item.short}: ${item.error}`;
			if (item.balanceUsd != null) {
				assertFinite(item.balanceUsd, "balanceUsd");
				const amount = item.balanceUsd < 0
					? `-$${Math.abs(item.balanceUsd).toFixed(2)}`
					: `$${item.balanceUsd.toFixed(2)}`;
				return `${item.short}: ${amount} remaining`;
			}
			const windows = item.windows
				.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`)
				.join(", ");
			return `${item.short}${item.plan ? `/${item.plan}` : ""}: ${windows || "n/a"}`;
		})
		.join(" | ");
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function buildStatsLeft(ctx: ExtensionContext, theme: ThemeLike): string {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as { usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			} }).usage;
			if (!usage) continue;
			totalInput += usage.input ?? 0;
			totalOutput += usage.output ?? 0;
			totalCacheRead += usage.cacheRead ?? 0;
			totalCacheWrite += usage.cacheWrite ?? 0;
			totalCost += usage.cost?.total ?? 0;
		}
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

	const parts: string[] = [];
	if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
	if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) {
		parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}

	const contextDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}`
			: `${contextPercent}%/${formatTokens(contextWindow)}`;
	parts.push(colorForPercent(theme, contextPercentValue, contextDisplay));
	return parts.join(" ");
}

type StatusEntry = [key: string, text: string];

function providerAlias(provider: string): string {
	switch (provider) {
		case "openai-codex":
			return "codex";
		case "github-copilot":
			return "copilot";
		case "google-gemini-cli":
			return "gemini";
		default:
			return provider;
	}
}

export function formatActiveModel(
	provider: string,
	modelId: string,
	statusEntries: StatusEntry[],
): { label: string; statuses: StatusEntry[] } {
	assert(provider.length > 0, "provider empty");
	assert(modelId.length > 0, "modelId empty");
	assert(statusEntries.length <= 64, "too many statuses");

	let effectiveModelId = modelId;
	let effort: string | undefined;
	const statuses: StatusEntry[] = [];
	for (const [key, text] of statusEntries) {
		if (key === "effort") {
			const match = /^effort:(off|minimal|low|medium|high|xhigh)$/.exec(stripAnsi(sanitizeStatusText(text)));
			if (match) {
				effort = match[1]!;
				continue;
			}
		}

		if (provider !== "cursor" || key !== "cursor") {
			statuses.push([key, text]);
			continue;
		}

		const remainingParts: string[] = [];
		for (const part of text.split(/\s*·\s*/)) {
			const fast = /^cursor-fast:(on|off|n\/a)$/.exec(part.trim());
			if (!fast) {
				if (part.trim()) remainingParts.push(part.trim());
				continue;
			}
			if (!/:(?:fast|slow)$/.test(effectiveModelId)) {
				if (fast[1] === "on") effectiveModelId = `${effectiveModelId}:fast`;
				if (fast[1] === "off") effectiveModelId = `${effectiveModelId}:slow`;
			}
		}
		if (remainingParts.length > 0) statuses.push([key, remainingParts.join(" · ")]);
	}

	return {
		label: `${providerAlias(provider)}/${effectiveModelId}${effort ? `:${effort}` : ""}`,
		statuses,
	};
}

export function packFooterLine(left: string, right: string, width: number, minGap = 2): string | null {
	assert(width > 0, "width must be positive");
	assert(minGap >= 1 && minGap <= 8, "minGap out of bounds");
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + minGap + rightWidth > width) return null;
	return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

export function packFooterLinePreserveRight(left: string, right: string, width: number, minGap = 2): string {
	const packed = packFooterLine(left, right, width, minGap);
	if (packed) return packed;

	const rightWidth = visibleWidth(right);
	if (rightWidth + minGap >= width) return truncateToWidth(right, width, "...");
	const availableLeft = width - rightWidth - minGap;
	assert(availableLeft > 0, "no left width despite fitting right");
	const truncatedLeft = truncateToWidth(left, availableLeft, "...");
	const fallback = packFooterLine(truncatedLeft, right, width, minGap);
	assert(fallback !== null, "truncated footer line did not fit");
	return fallback;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Fold domain/route statuses into `domain:route`, appending `lock` when either is locked. */
export function formatCompactStatuses(statuses: StatusEntry[]): string {
	assert(statuses.length <= 64, "too many statuses");
	let domain: string | null = null;
	let domainLocked = false;
	let route: string | null = null;
	let routeLocked = false;
	let clarify: string | null = null;
	const other: string[] = [];

	for (const [key, raw] of statuses) {
		const text = stripAnsi(sanitizeStatusText(raw));
		if (!text) continue;

		if (key === "domain") {
			const match = /^domain:(\S+)(?:\s*\((auto|lock)\))?$/.exec(text);
			if (match) {
				domain = match[1]!;
				domainLocked = match[2] === "lock";
				continue;
			}
		}

		if (key === "route") {
			const clarifyMatch = /^clarify:(\S+)(?:\s*\(([^)]*)\))?$/.exec(text);
			if (clarifyMatch) {
				clarify = clarifyMatch[1]!;
				routeLocked = /\block\b/.test(clarifyMatch[2] ?? "");
				continue;
			}
			const routeMatch = /^route:(\S+)(?:\s*\((auto|lock)\))?$/.exec(text);
			if (routeMatch) {
				route = routeMatch[1]!;
				routeLocked = routeMatch[2] === "lock";
				continue;
			}
		}

		other.push(text);
	}

	const parts: string[] = [];
	if (domain != null || route != null || clarify != null) {
		const domainPart = domain ?? "?";
		const routePart = clarify != null ? `~${clarify}` : (route ?? "?");
		let compact = `${domainPart}:${routePart}`;
		if (domainLocked || routeLocked) compact += " lock";
		parts.push(compact);
	}
	parts.push(...other);
	return parts.join(" ");
}

async function refresh(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			cached = await loadAllLimits();
			requestRender?.();
		} catch {
			// keep prior cache
		} finally {
			inFlight = undefined;
		}
	})();
	return inFlight;
}

function clearPoll(): void {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = undefined;
}

function shutdownUi(): void {
	clearPoll();
	requestRender = undefined;
	cached = [];
}

export default function subLimitsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const onRender = () => tui.requestRender();
			requestRender = onRender;

			return {
				dispose() {
					unsub();
					if (requestRender === onRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					assert(width > 0, "footer width must be positive");

					let pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const statusEntries = Array.from(footerData.getExtensionStatuses().entries()) as StatusEntry[];
					statusEntries.sort((a, b) => a[0].localeCompare(b[0]));
					const activeModel = ctx.model
						? formatActiveModel(ctx.model.provider, ctx.model.id, statusEntries)
						: { label: "no-model", statuses: statusEntries };

					const dimEllipsis = theme.fg("dim", "...");
					const pwdText = theme.fg("dim", pwd);
					const statsText = theme.fg("dim", buildStatsLeft(ctx, theme));
					const modelText = theme.fg("dim", activeModel.label);
					const primaryLeft = `${pwdText}  ${statsText}`;
					const compactPrimary = packFooterLine(primaryLeft, modelText, width);
					const lines: string[] = [];

					if (compactPrimary) {
						lines.push(compactPrimary);
					} else {
						lines.push(packFooterLinePreserveRight(pwdText, modelText, width));
						lines.push(truncateToWidth(statsText, width, dimEllipsis));
					}

					const quotaRows = formatQuotaRows(theme, cached, width);
					const compactStatuses = formatCompactStatuses(activeModel.statuses);
					const statusText = compactStatuses ? theme.fg("dim", compactStatuses) : "";

					if (quotaRows.length === 1 && statusText) {
						const compactSecondary = packFooterLine(quotaRows[0]!, statusText, width);
						if (compactSecondary) {
							lines.push(compactSecondary);
						} else {
							lines.push(quotaRows[0]!);
							lines.push(truncateToWidth(statusText, width, dimEllipsis));
						}
					} else {
						lines.push(...quotaRows);
						if (statusText) lines.push(truncateToWidth(statusText, width, dimEllipsis));
					}

					return lines;
				},
			};
		});

		await refresh();
		clearPoll();
		pollTimer = setInterval(() => {
			void refresh();
		}, POLL_MS);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shutdownUi();
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("limits", {
		description: "Refresh subscription limits and balances now",
		handler: async (_args, ctx) => {
			await refresh();
			ctx.ui.notify(formatLimitsSummary(cached), "info");
		},
	});
}
