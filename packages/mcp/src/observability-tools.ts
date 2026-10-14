/**
 * The observability tool surface: the reads an agent needs to answer "did my
 * change work, and what broke" — recent logs, grouped error Issues, schema
 * advisories, query insights, and migration status.
 *
 * A THIRD tier, distinct from the always-on read tools and the `allowWrites`
 * write tools. These are read-only in the `readOnlyHint` sense, but they
 * surface production logs, request metadata, and grouped errors — user data that
 * lands at the model provider — so they are advertised ONLY when
 * `allowObservability` is set: the same omit-don't-refuse rule the write gate
 * uses, plus a refusal at dispatch. See `./tools`, which owns both halves of
 * that gate. The admin bearer is NOT the gate; every tool already needs it.
 *
 * Every read is an existing `__lunora_admin__:*` RPC, reached through the same
 * `LunoraClient` (and therefore the same `/_lunora/rpc` transport and bearer)
 * the other tools use. The op paths come from `ADMIN_FUNCTIONS`; a hand-written
 * `"__lunora_admin__:…"` literal is how a renamed op ships a 404 to one
 * consumer and not another.
 */
import type { FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";

import { okStructured } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";

/** Introspection reads touch no state; every call goes to the deployment. */
const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;

/**
 * Rows returned when the caller passes no `limit`, and the ceiling a larger one
 * is clamped to.
 *
 * Deliberately far below the admin RPCs' own bounds (`getIssues` clamps to
 * 10000; the log ring holds 500): every row lands in a model's context window
 * and is paid for on every subsequent turn, so the binding constraint here is
 * context, not the datastore.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** The `range` tokens `getQueryInsights` understands; anything else falls back to its 15m default. */
const INSIGHT_RANGES = ["1m", "5m", "15m", "1h"] as const;

/** Triage states `getIssues` filters on. */
const ISSUE_STATUSES = ["open", "resolved", "ignored"] as const;

/** Log severities `ctx.log.*` records. */
const LOG_LEVELS = ["trace", "debug", "log", "info", "warn", "error", "fatal"] as const;

/**
 * A shard key every observability tool accepts. The reads are served by the
 * shard that handled the traffic, so on a `.shardBy()`-partitioned deployment
 * "the logs" are per-shard: reading one shard while presenting it as the whole
 * deployment would be actively misleading.
 */
const SHARD_KEY_PROPERTY = {
    description:
        "Shard to read from on a .shardBy()-partitioned deployment. Omit for the default (unsharded) shard — these reads are PER-SHARD, not deployment-wide.",
    type: "string",
} as const;

const LIMIT_PROPERTY = {
    description: `Maximum rows to return (default ${DEFAULT_LIMIT.toString()}, clamped to ${MAX_LIMIT.toString()}).`,
    type: "number",
} as const;

/** Clamp a caller-supplied `limit` into `[1, MAX_LIMIT]`, defaulting a missing/invalid one. */
const readLimit = (raw: unknown): number => {
    const value = typeof raw === "number" ? raw : Number.NaN;

    if (!Number.isFinite(value)) {
        return DEFAULT_LIMIT;
    }

    return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
};

/** Pass an input string through only when it is one of `allowed`; anything else is dropped (the RPC's own default applies). */
const readEnum = <T extends string>(raw: unknown, allowed: ReadonlyArray<T>): T | undefined => (allowed.includes(raw as T) ? (raw as T) : undefined);

/** A non-empty input string, or `undefined`. */
const readText = (raw: unknown): string | undefined => (typeof raw === "string" && raw.length > 0 ? raw : undefined);

const LOGS_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        level: { description: `Keep only entries at this severity. One of: ${LOG_LEVELS.join(", ")}.`, type: "string" },
        limit: LIMIT_PROPERTY,
        shardKey: SHARD_KEY_PROPERTY,
    },
    type: "object",
};

const ISSUES_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        functionPathPrefix: { description: 'Keep only Issues whose function path starts with this, e.g. "messages:".', type: "string" },
        limit: LIMIT_PROPERTY,
        shardKey: SHARD_KEY_PROPERTY,
        status: { description: `Triage status to keep. One of: ${ISSUE_STATUSES.join(", ")}. Default: all.`, type: "string" },
    },
    type: "object",
};

const ADVISORIES_INPUT_SCHEMA: ToolInputSchema = {
    properties: { limit: LIMIT_PROPERTY, shardKey: SHARD_KEY_PROPERTY },
    type: "object",
};

const INSIGHTS_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        limit: LIMIT_PROPERTY,
        range: { description: `Time window to report over. One of: ${INSIGHT_RANGES.join(", ")}. Default: 15m.`, type: "string" },
        shardKey: SHARD_KEY_PROPERTY,
    },
    type: "object",
};

const MIGRATION_STATUS_INPUT_SCHEMA: ToolInputSchema = {
    properties: { shardKey: SHARD_KEY_PROPERTY },
    type: "object",
};

/**
 * `outputSchema`s are shallow on purpose: they tell a client what the top-level
 * envelope is (and let it validate `structuredContent`), without pinning row
 * shapes that the admin RPCs are free to extend. A row schema copied here is a
 * second source of truth that goes stale silently.
 */
const LOGS_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        dropped: {
            description:
                "Entries the shard's in-memory ring EVICTED before this read — they are gone and cannot be fetched. Non-zero means `entries` + `total` describe only the newest slice of what the deployment logged.",
            type: "number",
        },
        entries: { description: "Recent log entries, NEWEST FIRST: { level, message, timestamp, functionPath?, fields? }.", type: "array" },
        total: {
            description: "Entries still in the ring matching `level`, before `limit` narrowed them. NOT the number of lines logged — see `dropped`.",
            type: "number",
        },
    },
    required: ["dropped", "entries", "total"],
    type: "object",
};

const ISSUES_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        issues: { description: "Grouped error Issues, newest first: { hash, title, count, status, functionPath, lastSeen, … }.", type: "array" },
    },
    required: ["issues"],
    type: "object",
};

const ADVISORIES_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        advisories: { description: "Schema/query advisories: { id, level, title, detail, … }.", type: "array" },
        total: { description: "Advisories available before `limit` narrowed them.", type: "number" },
    },
    required: ["advisories", "total"],
    type: "object",
};

const INSIGHTS_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        buckets: { description: "Combined throughput/latency series across the range.", type: "array" },
        capped: { description: "True when the deployment's tracked-statement cap was reached, so coverage is partial.", type: "boolean" },
        entries: { description: "Per-statement activity in the range, hottest first.", type: "array" },
        total: { description: "Statements available before `limit` narrowed them.", type: "number" },
        trackedStatements: { description: "Distinct statements the deployment is tracking.", type: "number" },
    },
    required: ["entries", "buckets"],
    type: "object",
};

const MIGRATION_STATUS_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        migrations: { description: "Every declared migration with its applied/pending state.", type: "array" },
    },
    required: ["migrations"],
    type: "object",
};

/**
 * The observability tools. Descriptions say WHEN to call the tool, not just
 * what it returns — an agent picking between five similar reads needs the
 * trigger, and it pays for these strings on every turn.
 */
const OBSERVABILITY_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read recent logs" },
        description:
            "Read the deployment's recent log entries (newest first) after running a function, to see what it printed and where it failed. In-memory and per-shard: resets when the shard hibernates.",
        inputSchema: LOGS_INPUT_SCHEMA,
        name: "lunora_get_logs",
        outputSchema: LOGS_OUTPUT_SCHEMA,
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "List grouped error Issues" },
        description:
            "List errors grouped into Issues by fingerprint, with occurrence counts and triage status — the first call when asking what is currently broken, rather than reading raw logs.",
        inputSchema: ISSUES_INPUT_SCHEMA,
        name: "lunora_get_issues",
        outputSchema: ISSUES_OUTPUT_SCHEMA,
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "List schema and query advisories" },
        description: "List the deployment's schema/query advisories (missing indexes, unsafe policies, and similar lints) before or after changing the schema.",
        inputSchema: ADVISORIES_INPUT_SCHEMA,
        name: "lunora_get_advisories",
        outputSchema: ADVISORIES_OUTPUT_SCHEMA,
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read query insights" },
        description: "Read per-statement execution counts and latency over a recent time window, to find which query is slow or hot before optimizing one.",
        inputSchema: INSIGHTS_INPUT_SCHEMA,
        name: "lunora_get_query_insights",
        outputSchema: INSIGHTS_OUTPUT_SCHEMA,
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read migration status" },
        description: "Read which migrations have been applied and which are pending, to check whether a schema change has actually landed on the deployment.",
        inputSchema: MIGRATION_STATUS_INPUT_SCHEMA,
        name: "lunora_get_migration_status",
        outputSchema: MIGRATION_STATUS_OUTPUT_SCHEMA,
    },
];

/** Names of the observability tools — used to gate them out of a server with no admin token. */
const OBSERVABILITY_TOOL_NAMES: ReadonlySet<string> = new Set(OBSERVABILITY_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * Call one admin RPC. `client.query` is the right seam and not a workaround:
 * the `__lunora_admin__:*` paths travel the same `POST /_lunora/rpc` envelope
 * as an ordinary function (the shard intercepts them before user dispatch), so
 * the bearer, the error envelope, and the response decode are all the client's
 * existing behaviour.
 */
const adminRead = async (client: LunoraClient, op: string, args: Record<string, unknown>, shardKey: string | undefined): Promise<unknown> => {
    const reference = { __lunoraRef: op } as FunctionReference;

    return client.query(reference, args, { ...(shardKey === undefined ? {} : { shardKey }) });
};

/** The array under `key` in an admin result, or `[]` when the deployment returned something else. */
const rowsOf = (result: unknown, key: string): unknown[] => {
    const value = (result as Record<string, unknown> | null | undefined)?.[key];

    return Array.isArray(value) ? value : [];
};

/** `getLogs` returns the whole ring; only `level` is read here, so the row stays open. */
interface LogRow {
    level?: unknown;
}

/**
 * Dispatch an observability tool. Throws on an unknown name or a failed RPC —
 * `callTool` owns the try/catch that turns either into an `isError` result, so
 * every tool family reports failures the same way.
 */
const callObservabilityTool = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const shardKey = readText(input.shardKey);
    const limit = readLimit(input.limit);

    switch (name) {
        case "lunora_get_advisories": {
            const result = await adminRead(client, ADMIN_FUNCTIONS.getAdvisories, {}, shardKey);
            const advisories = rowsOf(result, "advisories");

            return okStructured({ advisories: advisories.slice(0, limit), total: advisories.length });
        }
        case "lunora_get_issues": {
            const status = readEnum(input.status, ISSUE_STATUSES);
            const functionPathPrefix = readText(input.functionPathPrefix);
            // The RPC applies `limit`/`status`/`functionPathPrefix` itself (and
            // clamps the limit), so grouping happens over the right row set
            // rather than over a page this tool already truncated.
            const result = await adminRead(
                client,
                ADMIN_FUNCTIONS.getIssues,
                {
                    limit,
                    ...(status === undefined ? {} : { status }),
                    ...(functionPathPrefix === undefined ? {} : { functionPathPrefix }),
                },
                shardKey,
            );

            return okStructured({ issues: rowsOf(result, "issues") });
        }
        case "lunora_get_logs": {
            const level = readEnum(input.level, LOG_LEVELS);
            // `getLogs` takes no arguments and returns the entire in-memory ring
            // (up to 500 entries), so the narrowing happens here. Entries arrive
            // newest-first, so slicing keeps the most recent.
            const result = await adminRead(client, ADMIN_FUNCTIONS.getLogs, {}, shardKey);
            const entries = rowsOf(result, "entries").filter((entry) => level === undefined || (entry as LogRow).level === level);
            // The RPC's eviction counter, forwarded: a saturated ring is
            // otherwise indistinguishable from a shard that logged exactly as
            // many lines as it still holds, so a model asked "is this the whole
            // picture?" answers yes on a deployment that dropped 50,000 lines.
            const { dropped } = (result ?? {}) as { dropped?: unknown };

            return okStructured({ dropped: typeof dropped === "number" ? dropped : 0, entries: entries.slice(0, limit), total: entries.length });
        }
        case "lunora_get_migration_status": {
            const result = await adminRead(client, ADMIN_FUNCTIONS.migrationStatus, {}, shardKey);

            // No limit: the list is one row per declared migration, and dropping
            // its tail would hide exactly the pending one the caller is asking about.
            return okStructured({ migrations: rowsOf(result, "migrations") });
        }
        case "lunora_get_query_insights": {
            const range = readEnum(input.range, INSIGHT_RANGES);
            const result = await adminRead(client, ADMIN_FUNCTIONS.getQueryInsights, { ...(range === undefined ? {} : { range }) }, shardKey);
            const entries = rowsOf(result, "entries");
            const { buckets, capped, trackedStatements } = (result ?? {}) as { buckets?: unknown; capped?: unknown; trackedStatements?: unknown };

            return okStructured({
                buckets: Array.isArray(buckets) ? buckets : [],
                capped: capped === true,
                entries: entries.slice(0, limit),
                total: entries.length,
                trackedStatements: typeof trackedStatements === "number" ? trackedStatements : entries.length,
            });
        }
        default: {
            throw new LunoraError("INTERNAL", `unknown observability tool: ${name}`);
        }
    }
};

export { callObservabilityTool, DEFAULT_LIMIT, MAX_LIMIT, OBSERVABILITY_TOOL_DEFINITIONS, OBSERVABILITY_TOOL_NAMES };
