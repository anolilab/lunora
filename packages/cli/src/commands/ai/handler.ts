/**
 * `lunora ai gateway` — provision a Cloudflare AI Gateway and wire the Worker to it.
 *
 * `ctx.ai.model("<provider>/<model>")` routes through AI Gateway over the
 * Workers `env.AI` binding. Which gateway is read from `LUNORA_AI_GATEWAY_ID`
 * in the Worker env, falling back to the account's auto-created `default`
 * gateway. This command makes that id explicit: it creates (or reuses) a
 * gateway over the Cloudflare REST API and writes the id into the wrangler
 * config's `vars`, preserving comments and formatting.
 *
 * Credentials follow wrangler's own non-interactive convention —
 * `CLOUDFLARE_API_TOKEN` (needs the `AI Gateway Write` permission) and
 * `CLOUDFLARE_ACCOUNT_ID`, the latter falling back to the wrangler config's
 * `account_id`. The binding path itself is pre-authenticated, so no gateway
 * token is written.
 * @see https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/
 */
import { writeFileSync } from "node:fs";

import { applyModify, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { capErrorBody } from "../../../../../shared/cap-error-body";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { AiOptions } from "./index";
import { AI_GATEWAY_ACCOUNT_ID_VAR, AI_GATEWAY_ID_VAR } from "./variables";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** AI Gateway ids are 1–64 characters (the create endpoint's `id` constraint). */
const MAX_GATEWAY_ID_LENGTH = 64;

const DOCS = {
    byok: "https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/",
    unifiedBilling: "https://developers.cloudflare.com/ai-gateway/features/unified-billing/",
} as const;

/** The subset of the wrangler config this command reads. */
interface WranglerAiShape {
    account_id?: unknown;
    name?: unknown;
    vars?: Record<string, unknown>;
}

/** The credential env vars, injectable for tests. */
interface AiGatewayEnvironment {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
}

interface AiCommandOptions {
    cwd: string;
    dryRun?: boolean;
    /** Defaults to `process.env`. */
    environment?: AiGatewayEnvironment;
    /** Defaults to the global `fetch`; injected in tests so nothing touches the network. */
    fetch?: typeof globalThis.fetch;
    /** Explicit gateway id; defaults to the wrangler worker `name`. */
    id?: string;
    logger: Logger;
    /** Collect request/response logs in the gateway. Defaults to `true`. */
    logs?: boolean;
    subcommand: string | undefined;
}

/** The `--format json` payload. */
interface AiGatewayData {
    accountId?: string;
    /** `created` — made by this run; `existing` — already there and reused; `planned` — `--dry-run`. */
    action: "created" | "existing" | "planned";
    collectLogs: boolean;
    dryRun: boolean;
    gatewayId: string;
    /** The wrangler `vars` keys this run wrote (or, on `--dry-run`, would write). */
    varsWritten: string[];
    wranglerPath: string;
}

interface AiCommandResult {
    code: number;
    data?: AiGatewayData;
    error?: string;
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

const fail = (logger: Logger, code: number, message: string): AiCommandResult => {
    logger.error(message);

    return { code, error: message };
};

/** Cloudflare's `{ success, errors, result }` envelope, parsed defensively. */
interface CloudflareEnvelope {
    errors?: ReadonlyArray<{ code?: number; message?: string }>;
    result?: Record<string, unknown>;
    success?: boolean;
}

interface GatewayResponse {
    body: CloudflareEnvelope | undefined;
    ok: boolean;
    status: number;
    text: string;
}

const callGatewayApi = async (fetchImpl: typeof globalThis.fetch, url: string, token: string, init: RequestInit = {}): Promise<GatewayResponse> => {
    const response = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await response.text();
    let body: CloudflareEnvelope | undefined;

    try {
        body = JSON.parse(text) as CloudflareEnvelope;
    } catch {
        // A gateway 5xx can be an HTML page — keep the raw text for the message.
    }

    return { body, ok: response.ok && body?.success !== false, status: response.status, text };
};

/** A single-line, capped description of a failed API call. */
const describeFailure = (response: GatewayResponse): string => {
    const messages = (response.body?.errors ?? []).map((entry) => entry.message).filter((message): message is string => typeof message === "string");

    return `${String(response.status)}: ${capErrorBody(messages.length > 0 ? messages.join("; ") : response.text)}`;
};

/**
 * Rewrite the top-level wrangler `vars` so they carry `entries`, returning the
 * new text and the keys that actually changed. Uses the wrangler reconcilers'
 * shared `applyModify` so comments and formatting survive.
 */
const writeVariables = (text: string, current: Record<string, unknown> | undefined, entries: Record<string, string>): { changed: string[]; text: string } => {
    let next = text;
    const changed: string[] = [];

    for (const [key, value] of Object.entries(entries)) {
        if (current?.[key] === value) {
            continue;
        }

        next = applyModify(next, ["vars", key], value);
        changed.push(key);
    }

    return { changed, text: next };
};

const printNextSteps = (logger: Logger, gatewayId: string): void => {
    logger.info(`next: \`<provider>/<model>\` slugs (e.g. "anthropic/claude-sonnet-5") now route through gateway "${gatewayId}". Before the first call,`);
    logger.info(`  configure how the provider is paid for in the Cloudflare dashboard (AI > AI Gateway > ${gatewayId}):`);
    logger.info(`  - Unified Billing (OpenAI, Anthropic, Google, xAI, Groq, DeepSeek): load credits — ${DOCS.unifiedBilling}`);
    logger.info(`  - a key stored on the gateway (Mistral, Perplexity, OpenRouter, …): ${DOCS.byok}`);
    logger.info("  Then redeploy (`lunora deploy`) so the Worker picks up the new vars.");
};

/** Create the gateway, or reuse it when the id is already taken on the account. A failure is logged and returned as the command result. */
const ensureGateway = async (
    logger: Logger,
    fetchImpl: typeof globalThis.fetch,
    accountId: string,
    token: string,
    gatewayId: string,
    collectLogs: boolean,
): Promise<AiCommandResult | { action: "created" | "existing"; collectLogs: boolean }> => {
    const base = `${API_BASE}/${encodeURIComponent(accountId)}/ai-gateway/gateways`;
    const existing = await callGatewayApi(fetchImpl, `${base}/${encodeURIComponent(gatewayId)}`, token);

    if (existing.ok) {
        const reported = existing.body?.result?.["collect_logs"];

        return { action: "existing", collectLogs: typeof reported === "boolean" ? reported : collectLogs };
    }

    // A credential problem is reported as such. Any other miss falls through to
    // the create call: the API reference does not pin the status an unknown id
    // answers with, and a create failure carries the more useful error anyway.
    if (existing.status === 401 || existing.status === 403) {
        return fail(logger, exitCodeForStatus(existing.status), `ai gateway: could not read AI Gateway "${gatewayId}" (${describeFailure(existing)})`);
    }

    // The create endpoint requires these six fields; caching and rate limiting
    // stay off (`0`) so the gateway only observes until the user opts in.
    const created = await callGatewayApi(fetchImpl, base, token, {
        body: JSON.stringify({
            cache_invalidate_on_update: true,
            cache_ttl: 0,
            collect_logs: collectLogs,
            id: gatewayId,
            rate_limiting_interval: 0,
            rate_limiting_limit: 0,
        }),
        method: "POST",
    });

    if (!created.ok) {
        return fail(logger, exitCodeForStatus(created.status), `ai gateway: could not create AI Gateway "${gatewayId}" (${describeFailure(created)})`);
    }

    return { action: "created", collectLogs };
};

/** The wrangler config this run edits, and the gateway id it resolved. */
interface GatewayProject {
    gatewayId: string;
    parsed: WranglerAiShape;
    text: string;
    wranglerPath: string;
}

/**
 * Locate + parse the wrangler config and resolve the gateway id (`--id`, else
 * the worker `name`). A failure is logged and returned as the command result.
 */
const resolveProject = (options: AiCommandOptions): AiCommandResult | GatewayProject => {
    const { logger } = options;
    const wranglerPath = findWranglerFile(options.cwd);

    if (wranglerPath === undefined) {
        return fail(logger, EXIT_CODE.NOT_FOUND, "ai gateway: no wrangler.jsonc found — run `lunora init` (or `lunora dev`) first.");
    }

    const { parsed, text } = readWranglerJsonc<WranglerAiShape>(wranglerPath);

    if (parsed === undefined) {
        return fail(logger, EXIT_CODE.USAGE, `ai gateway: could not parse ${wranglerPath} as JSONC.`);
    }

    const gatewayId = nonEmpty(options.id) ?? nonEmpty(parsed.name);

    if (gatewayId === undefined) {
        return fail(logger, EXIT_CODE.USAGE, "ai gateway: no gateway id — pass --id <id>, or set `name` in wrangler.jsonc.");
    }

    if (gatewayId.length > MAX_GATEWAY_ID_LENGTH) {
        return fail(
            logger,
            EXIT_CODE.USAGE,
            `ai gateway: gateway id "${gatewayId}" is longer than ${String(MAX_GATEWAY_ID_LENGTH)} characters — pass a shorter --id.`,
        );
    }

    return { gatewayId, parsed, text, wranglerPath };
};

const onOff = (value: boolean): string => (value ? "on" : "off");

const runAiGateway = async (options: AiCommandOptions): Promise<AiCommandResult> => {
    const { logger } = options;
    const project = resolveProject(options);

    if ("code" in project) {
        return project;
    }

    const { gatewayId, parsed, text, wranglerPath } = project;
    const environment = options.environment ?? process.env;
    const collectLogs = options.logs !== false;
    const accountId = nonEmpty(environment.CLOUDFLARE_ACCOUNT_ID) ?? nonEmpty(parsed.account_id);
    // The account id is only read by bring-your-own providers (`resolveAiGateway`'s
    // `baseURL`); the binding path needs the gateway id alone.
    const variables: Record<string, string> = {
        [AI_GATEWAY_ID_VAR]: gatewayId,
        ...(accountId === undefined ? {} : { [AI_GATEWAY_ACCOUNT_ID_VAR]: accountId }),
    };
    const written = writeVariables(text, parsed.vars, variables);

    if (options.dryRun === true) {
        logger.info(`ai gateway (dry run): would create or reuse AI Gateway "${gatewayId}" (log collection ${onOff(collectLogs)}).`);
        logger.info(
            written.changed.length === 0
                ? `ai gateway (dry run): ${wranglerPath} vars are already up to date.`
                : `ai gateway (dry run): would write ${written.changed.join(", ")} into ${wranglerPath} vars.`,
        );

        return { code: 0, data: { accountId, action: "planned", collectLogs, dryRun: true, gatewayId, varsWritten: written.changed, wranglerPath } };
    }

    const token = nonEmpty(environment.CLOUDFLARE_API_TOKEN);

    if (token === undefined || accountId === undefined) {
        const missing = [
            token === undefined ? "CLOUDFLARE_API_TOKEN (an API token with AI Gateway Write)" : undefined,
            accountId === undefined ? "CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc)" : undefined,
        ].filter((entry) => entry !== undefined);

        return fail(logger, EXIT_CODE.AUTH, `ai gateway: missing ${missing.join(" and ")}.`);
    }

    const outcome = await ensureGateway(logger, options.fetch ?? globalThis.fetch.bind(globalThis), accountId, token, gatewayId, collectLogs);

    if ("code" in outcome) {
        return outcome;
    }

    if (outcome.action === "created") {
        logger.success(`ai gateway: created AI Gateway "${gatewayId}" (log collection ${onOff(outcome.collectLogs)}).`);
    } else {
        logger.info(
            `ai gateway: AI Gateway "${gatewayId}" already exists — reusing it (log collection ${onOff(outcome.collectLogs)}; change it in the dashboard).`,
        );
    }

    if (written.changed.length > 0) {
        writeFileSync(wranglerPath, written.text, "utf8");
        logger.success(`ai gateway: wrote ${written.changed.join(", ")} into ${wranglerPath} vars.`);
    } else {
        logger.info(`ai gateway: ${wranglerPath} vars are already up to date.`);
    }

    printNextSteps(logger, gatewayId);

    return {
        code: 0,
        data: { accountId, action: outcome.action, collectLogs: outcome.collectLogs, dryRun: false, gatewayId, varsWritten: written.changed, wranglerPath },
    };
};

/** Route one `lunora ai <subcommand>` invocation. `gateway` is the only one today. */
const runAiCommand = async (options: AiCommandOptions): Promise<AiCommandResult> => {
    if (options.subcommand !== "gateway") {
        return fail(options.logger, EXIT_CODE.USAGE, `ai: unknown subcommand "${options.subcommand ?? ""}" — expected: gateway. Example: lunora ai gateway`);
    }

    return runAiGateway(options);
};

/** `lunora ai <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AiOptions> = defineHandler<AiOptions, AiGatewayData>(({ argument, cwd, logger, options }) =>
    runAiCommand({
        cwd,
        dryRun: options.dryRun === true,
        id: options.id,
        logger,
        logs: options.logs,
        subcommand: argument[0],
    }),
);

export type { AiCommandOptions, AiCommandResult, AiGatewayData };
export { execute, runAiCommand };
