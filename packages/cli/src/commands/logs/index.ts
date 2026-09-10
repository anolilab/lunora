import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { TARGET_OPTION } from "../../util/deploy-target";

/**
 * `lunora logs [worker]` — three independent sources, one command:
 *
 * Default — stream a DEPLOYED Worker live by wrapping `wrangler tail`.
 *
 * `--durable` — read the persisted `ctx.log` archive back from R2 via R2 SQL
 * (what `pipelineLogSink` writes). Needs a configured Pipeline → R2 Data Catalog
 * table plus the `R2_SQL_*` credentials.
 *
 * `--local` — read what the RUNNING dev server captured. Needs no deploy and no
 * credentials at all, so it is the one source the inner loop can actually use.
 */
const logsCommand: Command = {
    argument: { description: "Worker name (defaults to the name in wrangler config)", name: "worker", type: String },
    description: "Stream live logs from a deployed Worker, the running dev server with --local, or the durable archive with --durable",
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "logs",
    options: [
        { description: "Cloudflare environment name", name: "env", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "Substring filter on log messages", name: "search", type: String },
        { description: "Filter by invocation status: ok, error, or canceled", name: "status", type: String },
        TARGET_OPTION,
        {
            description: "Tail a temporary-account deployment when unauthenticated (wrangler tail --temporary). Errors if you're already authenticated.",
            name: "temporary",
            type: Boolean,
        },
        // --- local dev-server capture (--local) ---
        { description: "Read what the running dev server captured instead of tailing a deployment (no deploy needed)", name: "local", type: Boolean },
        { description: "local: dev-server base URL when it is not on http://localhost:5173", name: "url", type: String },
        // --- durable-archive path (--durable) ---
        { description: "Read the durable log archive (pipelineLogSink → R2) via R2 SQL instead of tailing live", name: "durable", type: Boolean },
        { description: "durable: Iceberg table the Pipeline writes to (required with --durable)", name: "table", type: String },
        { description: "durable: Iceberg namespace (R2 Data Catalog database) the table lives in", name: "namespace", type: String },
        { description: "durable: lower time bound (epoch-millis or ISO 8601), inclusive", name: "since", type: String },
        { description: "durable: upper time bound (epoch-millis or ISO 8601), inclusive", name: "until", type: String },
        { description: "durable: exact severity filter (trace|debug|log|info|warn|error|fatal)", name: "level", type: String },
        { description: "durable: severity floor — this level and every more-severe one", name: "min-level", type: String },
        { description: "durable: keep function paths starting with this prefix (LIKE 'prefix%')", name: "function-prefix", type: String },
        { description: "durable: trace-id filter", name: "trace-id", type: String },
        { description: "durable: shard-key filter", name: "shard-key", type: String },
        { description: "durable: user-id filter", name: "user-id", type: String },
        { description: "durable: max rows (clamped to 1–10000; default 500)", name: "limit", type: String },
        {
            description:
                "durable: resume after a prior page — the opaque cursor token printed by the previous page (bare epoch-millis also accepted for back-compat)",
            name: "cursor",
            type: String,
        },
        { description: "durable: emit one JSON object per line instead of a table", name: "ndjson", type: Boolean },
    ],
};

export { logsCommand };

export type LogsOptions = CreateOptions<{
    cursor: string | undefined;
    durable: boolean | undefined;
    env: string | undefined;
    format: string | undefined;
    "function-prefix": string | undefined;
    level: string | undefined;
    limit: string | undefined;
    local: boolean | undefined;
    "min-level": string | undefined;
    namespace: string | undefined;
    ndjson: boolean | undefined;
    search: string | undefined;
    "shard-key": string | undefined;
    since: string | undefined;
    status: string | undefined;
    table: string | undefined;
    target: string | undefined;
    temporary: boolean | undefined;
    "trace-id": string | undefined;
    until: string | undefined;
    url: string | undefined;
    "user-id": string | undefined;
}>;
