/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks OpenCode Go usage limits at startup and displays a clean summary
 * widget above the editor.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ───────── Types ─────────

type GoModelStatus = "available" | "rate_limited" | "credits_error" | "error" | "no_key";
type GoProbeApi = "openai-completions" | "anthropic-messages";

interface AuthApiKeyCredential {
	type?: "api_key";
	key?: string;
}

type AuthJson = Record<string, AuthApiKeyCredential | undefined>;

interface GoCheckModel {
	id: string;
	api: GoProbeApi;
	endpoint: string;
	costRank: number;
}

interface OpenCodeGoUsage {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	quotaConfigured?: boolean;
	quotaSource?: string;
	rollingUsedPercent?: number;
	rollingRemainingPercent?: number;
	rollingResetAfterSeconds?: number;
	rollingResetAt?: number;
	weeklyUsedPercent?: number;
	weeklyRemainingPercent?: number;
	weeklyResetAfterSeconds?: number;
	weeklyResetAt?: number;
	monthlyUsedPercent?: number;
	monthlyRemainingPercent?: number;
	monthlyResetAfterSeconds?: number;
	monthlyResetAt?: number;
	quotaError?: string;
	errorMessage?: string;
	error?: string;
}

interface OpenCodeGoQuotaConfig {
	workspaceId: string;
	authCookie: string;
	source: string;
}

interface OpenCodeGoQuotaConfigState {
	config?: OpenCodeGoQuotaConfig;
	error?: string;
}

interface OpenCodeGoQuotaResult {
	configured: boolean;
	source?: string;
	rollingUsedPercent?: number;
	rollingRemainingPercent?: number;
	rollingResetAfterSeconds?: number;
	rollingResetAt?: number;
	weeklyUsedPercent?: number;
	weeklyRemainingPercent?: number;
	weeklyResetAfterSeconds?: number;
	weeklyResetAt?: number;
	monthlyUsedPercent?: number;
	monthlyRemainingPercent?: number;
	monthlyResetAfterSeconds?: number;
	monthlyResetAt?: number;
	error?: string;
}

// ───────── Config ─────────

const WIDGET_ID = "pi-usage";
const CHECK_TIMEOUT_MS = 15_000;
const AUTO_REFRESH_MINUTES = parseEnvInt("PI_USAGE_REFRESH_MIN", 30);
const AUTO_DISMISS_MS = parseEnvInt("PI_USAGE_AUTO_DISMISS_SEC", 15) * 1000;
const OPENCODE_GO_QUOTA_CONFIG_FILE = path.join("opencode-quota", "opencode-go.json");
const OPENCODE_GO_DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace";

// OpenCode Go publishes a fixed dollar limit, but no public usage/balance API.
// These are used only as the probe fallback when the installed pi model registry
// does not yet include a documented Go model.
const DOCUMENTED_GO_MODELS: GoCheckModel[] = [
	{ id: "qwen3.5-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 1 },
	{ id: "minimax-m2.5", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 2 },
	{ id: "minimax-m2.7", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 3 },
	{ id: "qwen3.6-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 4 },
	{ id: "mimo-v2-omni", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 5 },
	{ id: "kimi-k2.5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 6 },
	{ id: "glm-5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 7 },
	{ id: "kimi-k2.6", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 8 },
	{ id: "mimo-v2-pro", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 9 },
	{ id: "glm-5.1", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 10 },
];

// ───────── Helpers ─────────

function parseEnvInt(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authJsonPath(): string {
	return path.join(os.homedir(), ".pi/agent/auth.json");
}

function readAuthJson(): AuthJson | undefined {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthJson;
	} catch {
		return undefined;
	}
}

function dedupe(list: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function configPathCandidates(fileName: string): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	const explicit = process.env.OPENCODE_GO_QUOTA_CONFIG?.trim();
	if (explicit) candidates.push(explicit);

	const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
	if (xdgConfig) candidates.push(path.join(xdgConfig, "opencode", fileName));
	candidates.push(path.join(home, ".config", "opencode", fileName));

	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
		candidates.push(path.join(appData, "opencode", fileName));
		candidates.push(path.join(localAppData, "opencode", fileName));
	} else if (process.platform === "darwin") {
		candidates.push(path.join(home, "Library", "Application Support", "opencode", fileName));
	}

	return dedupe(candidates);
}

function getOpenCodeGoQuotaConfig(): OpenCodeGoQuotaConfigState {
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId || authCookie) {
		if (workspaceId && authCookie) {
			return { config: { workspaceId, authCookie, source: "env" } };
		}
		return {
			error: "OpenCode Go quota env needs both OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE",
		};
	}

	for (const configPath of configPathCandidates(OPENCODE_GO_QUOTA_CONFIG_FILE)) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
				workspaceId?: unknown;
				authCookie?: unknown;
			};
			const fileWorkspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
			const fileAuthCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
			if (!fileWorkspaceId || !fileAuthCookie) {
				return { error: `${configPath} needs workspaceId and authCookie` };
			}
			return {
				config: {
					workspaceId: fileWorkspaceId,
					authCookie: fileAuthCookie,
					source: configPath,
				},
			};
		} catch (e: unknown) {
			return {
				error: `${configPath}: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	return {};
}

function getOpenCodeApiKey(): string | undefined {
	const auth = readAuthJson();
	const goKey = getAuthApiKey(auth, "opencode-go");
	if (goKey) return goKey;
	const zenKey = getAuthApiKey(auth, "opencode");
	if (zenKey) return zenKey;
	return process.env.OPENCODE_API_KEY;
}

function getAuthApiKey(auth: AuthJson | undefined, provider: string): string | undefined {
	const credential = auth?.[provider] as AuthApiKeyCredential | undefined;
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	return resolveConfigValue(credential.key);
}

function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		try {
			return execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return process.env[config] || config;
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}h`;
	return `${Math.round(seconds / 86400 * 10) / 10}d`;
}

function formatResetTime(unixTsSec: number): string {
	const diff = unixTsSec * 1000 - Date.now();
	if (diff <= 0) return "now";
	return formatDuration(diff / 1000);
}

function progressBar(percent: number, width: number = 20): string {
	const filled = Math.round((Math.min(percent, 100) / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

function usageColor(percent: number): string {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function statusIcon(status: GoModelStatus): string {
	switch (status) {
		case "available": return "✓";
		case "rate_limited": return "⏳";
		case "credits_error": return "✗";
		case "error": return "⚠";
		case "no_key": return "—";
	}
}

// ───────── OpenCode Go Usage Check ─────────

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

function parseOpenCodeGoUsageWindow(
	html: string,
	key: "rolling" | "weekly" | "monthly",
): { usedPercent: number; remainingPercent: number; resetAfterSeconds: number; resetAt: number } | undefined {
	const objectMatch = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`).exec(html);
	const body = objectMatch?.[1];
	if (!body) return undefined;

	const usageMatch = /usagePercent:(\d+(?:\.\d+)?)/.exec(body);
	if (!usageMatch) return undefined;

	const usedPercent = clampPercent(Number(usageMatch[1]));
	const resetMatch = /resetInSec:(\d+(?:\.\d+)?)/.exec(body);
	const resetAfterSeconds = resetMatch ? Math.max(0, Math.round(Number(resetMatch[1]))) : 0;
	return {
		usedPercent,
		remainingPercent: clampPercent(100 - usedPercent),
		resetAfterSeconds,
		resetAt: resetAfterSeconds > 0 ? Math.round(Date.now() / 1000) + resetAfterSeconds : 0,
	};
}

function parseOpenCodeGoDashboardUsage(html: string): Omit<OpenCodeGoQuotaResult, "configured" | "source"> | undefined {
	const rolling = parseOpenCodeGoUsageWindow(html, "rolling");
	const weekly = parseOpenCodeGoUsageWindow(html, "weekly");
	const monthly = parseOpenCodeGoUsageWindow(html, "monthly");
	if (!rolling && !weekly && !monthly) return undefined;

	return {
		rollingUsedPercent: rolling?.usedPercent,
		rollingRemainingPercent: rolling?.remainingPercent,
		rollingResetAfterSeconds: rolling?.resetAfterSeconds,
		rollingResetAt: rolling?.resetAt,
		weeklyUsedPercent: weekly?.usedPercent,
		weeklyRemainingPercent: weekly?.remainingPercent,
		weeklyResetAfterSeconds: weekly?.resetAfterSeconds,
		weeklyResetAt: weekly?.resetAt,
		monthlyUsedPercent: monthly?.usedPercent,
		monthlyRemainingPercent: monthly?.remainingPercent,
		monthlyResetAfterSeconds: monthly?.resetAfterSeconds,
		monthlyResetAt: monthly?.resetAt,
	};
}

async function fetchOpenCodeGoQuota(config: OpenCodeGoQuotaConfig): Promise<OpenCodeGoQuotaResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

	try {
		const response = await fetch(
			`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`,
			{
				headers: {
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Cookie": `auth=${config.authCookie}`,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				signal: controller.signal,
			},
		);

		if (!response.ok) {
			return {
				configured: true,
				source: config.source,
				error: `OpenCode Go quota dashboard returned HTTP ${response.status}`,
			};
		}

		const html = await response.text();
		const parsed = parseOpenCodeGoDashboardUsage(html);
		if (!parsed) {
			return {
				configured: true,
				source: config.source,
				error: "OpenCode Go quota data was not found in the dashboard response",
			};
		}

		return {
			configured: true,
			source: config.source,
			...parsed,
		};
	} catch (e: unknown) {
		return {
			configured: true,
			source: config.source,
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function checkOpenCodeGoQuota(state: OpenCodeGoQuotaConfigState): Promise<OpenCodeGoQuotaResult> {
	if (state.error) {
		return { configured: false, error: state.error };
	}
	if (!state.config) {
		return { configured: false };
	}
	return fetchOpenCodeGoQuota(state.config);
}

function resolveModelEndpoint(baseUrl: string, api: GoProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		if (normalized.endsWith("/messages")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/messages`;
		return `${normalized}/v1/messages`;
	}
	if (normalized.endsWith("/chat/completions")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
	return `${normalized}/v1/chat/completions`;
}

function getOpenCodeGoCheckModels(): GoCheckModel[] {
	const modelsById = new Map<string, GoCheckModel>();
	for (const model of DOCUMENTED_GO_MODELS) {
		modelsById.set(model.id, model);
	}
	for (const model of getModels("opencode-go")) {
		if (modelsById.has(model.id)) continue;
		const api = model.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
		const costRank = model.cost.input + model.cost.output + model.cost.cacheRead + model.cost.cacheWrite;
		modelsById.set(model.id, {
			id: model.id,
			api,
			endpoint: resolveModelEndpoint(model.baseUrl, api),
			costRank,
		});
	}
	return Array.from(modelsById.values()).sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const body = await response.text();
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

function isPerModelUnavailable(status: number, message: string): boolean {
	if (status === 400 || status === 404 || status === 422) return true;
	return /model.*(disabled|not.*found|unsupported|unavailable)|disabled.*model/i.test(message);
}

function isGlobalGoLimit(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|opencode.*(quota|limit)|go.*(quota|limit)|subscription.*(quota|limit)/i.test(message);
}

async function probeOpenCodeGoModel(apiKey: string, model: GoCheckModel, signal: AbortSignal): Promise<Response> {
	if (model.api === "anthropic-messages") {
		return fetch(model.endpoint, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
				stream: false,
			}),
			signal,
		});
	}

	return fetch(model.endpoint, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model.id,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		}),
		signal,
	});
}

async function checkOpenCodeGoModels(apiKey: string | undefined): Promise<OpenCodeGoUsage> {
	if (!apiKey) {
		return {
			available: false,
			status: "no_key",
		};
	}

	const models = getOpenCodeGoCheckModels();
	let checkedModels = 0;
	let lastRateLimit: { model: string; message: string } | undefined;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeOpenCodeGoModel(apiKey, model, controller.signal);
			} finally {
				clearTimeout(timeout);
			}

			if (response.ok) {
				try { await response.text(); } catch { /* ignore */ }
				return {
					available: true,
					status: "available",
					workingModel: model.id,
					rateLimitedModel: lastRateLimit?.model,
					checkedModels,
					totalModels: models.length,
				};
			}

			if (response.status === 429) {
				const errorMsg = await readErrorMessage(response, "Rate limited");
				lastRateLimit = { model: model.id, message: errorMsg };

				if (isGlobalGoLimit(errorMsg)) {
					return {
						available: false,
						status: "rate_limited",
						rateLimitedModel: model.id,
						checkedModels,
						totalModels: models.length,
						errorMessage: errorMsg,
					};
				}
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				const errorMsg = await readErrorMessage(response, "Authentication error");
				const status: GoModelStatus = /credit|balance|quota|insufficient/i.test(errorMsg)
					? "credits_error"
					: "error";
				return {
					available: false,
					status,
					checkedModels,
					totalModels: models.length,
					errorMessage: errorMsg,
				};
			}

			const errorMsg = await readErrorMessage(response, `HTTP ${response.status}`);
			if (isPerModelUnavailable(response.status, errorMsg)) {
				lastUnavailable = { model: model.id, message: errorMsg };
				continue;
			}

			return {
				available: false,
				status: "error",
				checkedModels,
				totalModels: models.length,
				errorMessage: `${model.id}: ${errorMsg}`,
			};
		}

		if (lastRateLimit) {
			return {
				available: false,
				status: "rate_limited",
				rateLimitedModel: lastRateLimit.model,
				checkedModels,
				totalModels: models.length,
				errorMessage: lastRateLimit.message,
			};
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			errorMessage: `No documented Go models were available.${suffix}`,
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function checkOpenCodeGoUsage(
	apiKey: string | undefined,
	quotaState: OpenCodeGoQuotaConfigState,
): Promise<OpenCodeGoUsage> {
	const quotaCheck = await checkOpenCodeGoQuota(quotaState);
	if (
		quotaCheck.rollingUsedPercent !== undefined ||
		quotaCheck.weeklyUsedPercent !== undefined ||
		quotaCheck.monthlyUsedPercent !== undefined
	) {
		const quotaExhausted = (
			quotaCheck.rollingUsedPercent !== undefined && quotaCheck.rollingUsedPercent >= 100
		) || (
			quotaCheck.weeklyUsedPercent !== undefined && quotaCheck.weeklyUsedPercent >= 100
		) || (
			quotaCheck.monthlyUsedPercent !== undefined && quotaCheck.monthlyUsedPercent >= 100
		);
		return {
			available: !quotaExhausted,
			status: quotaExhausted ? "rate_limited" : "available",
			quotaConfigured: quotaCheck.configured,
			quotaSource: quotaCheck.source,
			rollingUsedPercent: quotaCheck.rollingUsedPercent,
			rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
			rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
			rollingResetAt: quotaCheck.rollingResetAt,
			weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
			weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
			weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
			weeklyResetAt: quotaCheck.weeklyResetAt,
			monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
			monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
			monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
			monthlyResetAt: quotaCheck.monthlyResetAt,
		};
	}

	const modelCheck = await checkOpenCodeGoModels(apiKey);

	return {
		...modelCheck,
		quotaConfigured: quotaCheck.configured,
		quotaSource: quotaCheck.source,
		rollingUsedPercent: quotaCheck.rollingUsedPercent,
		rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
		rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
		rollingResetAt: quotaCheck.rollingResetAt,
		weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
		weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
		weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
		weeklyResetAt: quotaCheck.weeklyResetAt,
		monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
		monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
		monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
		monthlyResetAt: quotaCheck.monthlyResetAt,
		quotaError: quotaCheck.error,
	};
}

// ───────── Widget Rendering ─────────

function buildUsageWidget(
	go: OpenCodeGoUsage | undefined,
	theme: any,
	loading: boolean,
): Text {
	if (loading) {
		return new Text(theme.fg("muted", "⚡ Checking usage limits..."), 0, 0);
	}

	const lines: string[] = [];
	const sep = "─";

	// Header
	lines.push(theme.bold(theme.fg("accent", "⚡ Usage Limits")));

	// ── OpenCode Go ──
	if (go) {
		lines.push(theme.fg("dim", sep.repeat(40)));
		const icon = statusIcon(go.status);
		const goColorMap: Record<GoModelStatus, string> = {
			available: "success",
			rate_limited: "warning",
			credits_error: "error",
			error: "warning",
			no_key: "dim",
		};
		const goColor = goColorMap[go.status];
		const statusText: Record<GoModelStatus, string> = {
			available: "available",
			rate_limited: "rate limited",
			credits_error: "credits exhausted",
			error: "error",
			no_key: "no key",
		};
		lines.push(`${theme.fg(goColor, `${icon} OpenCode Go`)} ${theme.fg("dim", "— " + statusText[go.status])}`);
		const goWindows = [
			{
				label: "rolling",
				used: go.rollingUsedPercent,
				remaining: go.rollingRemainingPercent,
				resetAt: go.rollingResetAt,
				resetAfterSeconds: go.rollingResetAfterSeconds,
			},
			{
				label: "week",
				used: go.weeklyUsedPercent,
				remaining: go.weeklyRemainingPercent,
				resetAt: go.weeklyResetAt,
				resetAfterSeconds: go.weeklyResetAfterSeconds,
			},
			{
				label: "month",
				used: go.monthlyUsedPercent,
				remaining: go.monthlyRemainingPercent,
				resetAt: go.monthlyResetAt,
				resetAfterSeconds: go.monthlyResetAfterSeconds,
			},
		];
		for (const window of goWindows) {
			if (window.used === undefined) continue;
			const windowColor = usageColor(window.used);
			const windowBar = progressBar(window.used);
			const resetStr = window.resetAt
				? ` (resets ${formatResetTime(window.resetAt)})`
				: window.resetAfterSeconds !== undefined
					? ` (resets in ${formatDuration(window.resetAfterSeconds)})`
					: "";

			// Pacing: ideal usage if evenly distributed through the period
			const paceTotalDays = window.label === "week" ? 7 : window.label === "month" ? 30 : 0;
			const remainingSec = window.resetAfterSeconds ?? (window.resetAt ? Math.max(0, window.resetAt - Date.now() / 1000) : 0);
			const paceStr = (paceTotalDays > 0 && remainingSec > 0)
				? ` / ${((Math.max(0, paceTotalDays - remainingSec / 86400) / paceTotalDays) * 100).toFixed(0)}% paced`
				: "";

			lines.push(
				`  ${window.label.padEnd(7)} ${theme.fg(windowColor, windowBar)} ${theme.fg(windowColor, `${window.used.toFixed(0)}% used`)}${theme.fg("dim", paceStr + resetStr)}`,
			);
		}
		if (go.quotaError) {
			lines.push(`  ${theme.fg("dim", `quota: ${go.quotaError.substring(0, 80)}`)}`);
		}
		if (go.workingModel) {
			lines.push(`  ${theme.fg("dim", `working: ${go.workingModel}`)}`);
		}
		if (go.checkedModels && go.totalModels) {
			lines.push(`  ${theme.fg("dim", `checked: ${go.checkedModels}/${go.totalModels} Go models`)}`);
		}
		if (go.rateLimitedModel) {
			lines.push(`  ${theme.fg("warning", `limited: ${go.rateLimitedModel}`)}`);
		}
		if (go.errorMessage) {
			lines.push(`  ${theme.fg("dim", go.errorMessage.substring(0, 80))}`);
		}
		if (go.error) {
			lines.push(`  ${theme.fg("dim", go.error.substring(0, 80))}`);
		}
	} else {
		lines.push(theme.fg("dim", sep.repeat(40)));
		lines.push(theme.fg("dim", "OpenCode Go — not configured"));
	}

	return new Text(lines.join("\n"), 0, 0);
}

// ───────── Status Line ─────────

function goFooterSummary(go: OpenCodeGoUsage): string {
	const quotaParts: string[] = [];
	if (go.rollingUsedPercent !== undefined) quotaParts.push(`${go.rollingUsedPercent.toFixed(0)}%r`);
	if (go.weeklyUsedPercent !== undefined) quotaParts.push(`${go.weeklyUsedPercent.toFixed(0)}%w`);
	if (go.monthlyUsedPercent !== undefined) quotaParts.push(`${go.monthlyUsedPercent.toFixed(0)}%m`);
	return quotaParts.length > 0 ? quotaParts.join("/") : statusIcon(go.status);
}

function updateFooterStatus(ctx: any, go: OpenCodeGoUsage | undefined): void {
	if (!ctx.hasUI) return;

	if (go) {
		ctx.ui.setStatus("pi-usage", `⚡ Go:${goFooterSummary(go)}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;
	let currentCtx: any;

	function dismissWidget(): void {
		if (currentCtx?.hasUI) {
			currentCtx.ui.setWidget(WIDGET_ID, undefined as any);
		}
		dismissTimer = undefined;
	}

	function scheduleDismiss(): void {
		if (dismissTimer) clearTimeout(dismissTimer);
		if (AUTO_DISMISS_MS > 0) {
			dismissTimer = setTimeout(dismissWidget, AUTO_DISMISS_MS);
		}
	}

	async function refreshUsage(ctx: any): Promise<void> {
		if (isLoading) return;
		isLoading = true;
		currentCtx = ctx;

		// Show loading state
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(goUsage, theme, true),
			);
		}

		// Check OpenCode Go
		const goKey = getOpenCodeApiKey();
		const goQuotaState = getOpenCodeGoQuotaConfig();
		if (goKey || goQuotaState.config || goQuotaState.error) {
			try {
				goUsage = await checkOpenCodeGoUsage(goKey, goQuotaState);
			} catch {
				goUsage = undefined;
			}
		} else {
			goUsage = undefined;
		}

		isLoading = false;

		// Update widget with results
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(goUsage, theme, false),
			);

			// Auto-dismiss widget after timeout (0 = keep forever)
			scheduleDismiss();

			// Footer status
			updateFooterStatus(ctx, goUsage);

			// Quick notification
			if (goUsage) {
				ctx.ui.notify(`⚡ Go:${goFooterSummary(goUsage)}`, "info");
			}
		}
	}

	// ── Startup check ──
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "reload") {
			// Small delay to let TUI settle
			setTimeout(() => refreshUsage(ctx), 500);
		}
	});

	// ── Auto-refresh ──
	pi.on("session_start", async (_event, ctx) => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentCtx) refreshUsage(currentCtx).catch(() => {});
		}, AUTO_REFRESH_MINUTES * 60 * 1000);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = undefined;
		}
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx);
		},
	});
}
