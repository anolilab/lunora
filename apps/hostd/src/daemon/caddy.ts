/**
 * The box's edge (plan 458 W5, on-box half): Caddy in front of every fleet,
 * configured from the control plane's `routes` table through Caddy's JSON
 * admin API on loopback — Noite's `caddy.rs` behaviour, as JSON.
 *
 * One route per alias, matched on its hostnames, reverse-proxied to the
 * fleet's loopback Worker port and readiness-gated: active health checks on
 * celld's health route, plus `try_duration` while a fleet boots. Responses are
 * compressed with zstd or gzip for compressible types only, so a
 * `text/event-stream` is never buffered or compressed (`flush_interval: -1`).
 * A slowloris guard (`read_header_timeout`) and bounded upstream waits; a
 * per-client `rate_limit` zone per alias (our Caddy build compiles in
 * `caddy-ratelimit`); on-demand TLS gated by hostd's own `ask` endpoint, which
 * approves only a routed hostname or the box's own; and a JSON access log to
 * a file hostd tails for request counts (W6).
 *
 * A config is posted only when it changed. One Caddy rejects keeps the
 * previous config serving, and the rejection is kept for `diagnose`.
 */
import type { Server } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";

import type { RouteEntry } from "../wire/types";
import type { CaddyConfig } from "./config";
import { writeFileAtomic } from "./config";
import type { Logger } from "./log";
import { CELLD_HEALTH_PATH } from "./supervisor";

/** Requests one client may make to one alias per window before Caddy answers 429. */
const RATE_LIMIT = { maxEvents: 600, window: "10s" } as const;

/** The logger Caddy writes access lines to; hostd's access-log writer includes only it. */
const ACCESS_LOGGER = "lunora";

/** Response types worth compressing. Deliberately no `text/event-stream`: an SSE response streams through untouched. */
const COMPRESSIBLE_TYPES = [
    "application/javascript*",
    "application/json*",
    "application/manifest+json*",
    "application/wasm*",
    "application/xml*",
    "image/svg+xml*",
    "text/css*",
    "text/html*",
    "text/javascript*",
    "text/plain*",
    "text/xml*",
];

interface CaddyBuildInput {
    /** Where Caddy writes the JSON access log hostd tails. */
    accessLogPath: string;
    caddy: CaddyConfig;
    /** The box's own hostname: always allowed a certificate, answers a plain 200. */
    hostname: string;
    /** Each alias with a running fleet → its loopback Worker port. An alias without one answers 503. */
    ports: ReadonlyMap<string, number>;
    routes: ReadonlyArray<RouteEntry>;
}

type Json = Record<string, unknown>;

const staticResponse = (status: number, body: string): Json => {
    return { body, close: status >= 500, handler: "static_response", status_code: status };
};

/** The handlers serving one alias: rate limit, compression, then the readiness-gated proxy. */
const aliasHandlers = (alias: string, port: number | undefined): Json[] => {
    if (port === undefined) {
        return [staticResponse(503, `${alias} is not running on this box\n`)];
    }

    return [
        {
            handler: "rate_limit",
            rate_limits: { [alias]: { key: "{http.request.remote.host}", max_events: RATE_LIMIT.maxEvents, window: RATE_LIMIT.window } },
        },
        {
            encodings: { gzip: {}, zstd: {} },
            handler: "encode",
            match: { headers: { "Content-Type": COMPRESSIBLE_TYPES } },
            prefer: ["zstd", "gzip"],
        },
        {
            flush_interval: -1,
            handler: "reverse_proxy",
            health_checks: { active: { interval: "1s", timeout: "2s", uri: CELLD_HEALTH_PATH } },
            load_balancing: { try_duration: "20s", try_interval: "250ms" },
            transport: { dial_timeout: "5s", protocol: "http", response_header_timeout: "30s" },
            upstreams: [{ dial: `127.0.0.1:${String(port)}` }],
        },
    ];
};

/** The full Caddy JSON config for a routing table. Deterministic: the same input gives the same bytes. */
const buildCaddyConfig = (input: CaddyBuildInput): Json => {
    const hostsByAlias = new Map<string, string[]>();

    for (const { alias, hostname } of input.routes) {
        hostsByAlias.set(alias, [...(hostsByAlias.get(alias) ?? []), hostname]);
    }

    const routes: Json[] = [...hostsByAlias.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([alias, hosts]) => {
            return {
                handle: [{ handler: "subroute", routes: [{ handle: aliasHandlers(alias, input.ports.get(alias)) }] }],
                match: [{ host: hosts.toSorted((a, b) => a.localeCompare(b)) }],
                terminal: true,
            };
        });

    routes.push(
        { handle: [staticResponse(200, "lunora-hostd\n")], match: [{ host: [input.hostname] }], terminal: true },
        { handle: [staticResponse(404, "no app is routed to this hostname\n")], terminal: true },
    );

    const { caddy } = input;

    return {
        admin: { listen: caddy.adminAddress },
        apps: {
            http: {
                http_port: caddy.httpPort,
                https_port: caddy.httpsPort,
                servers: {
                    lunora: {
                        ...(caddy.tls ? {} : { automatic_https: { disable: true } }),
                        idle_timeout: "2m",
                        listen: [`:${String(caddy.tls ? caddy.httpsPort : caddy.httpPort)}`],
                        logs: { default_logger_name: ACCESS_LOGGER },
                        // Slowloris: a client trickling its headers is dropped, not held open.
                        read_header_timeout: "10s",
                        routes,
                    },
                },
            },
            ...(caddy.tls
                ? {
                      tls: {
                          automation: {
                              on_demand: { permission: { endpoint: `http://${caddy.askAddress}/ask`, module: "http" } },
                              policies: [{ on_demand: true }],
                          },
                      },
                  }
                : {}),
        },
        logging: {
            logs: {
                // One line per rejected request would flood the journal during the very flood the limit absorbs.
                default: { exclude: [`http.log.access.${ACCESS_LOGGER}`, "http.handlers.rate_limit"] },
                lunora_access: {
                    encoder: { format: "json" },
                    include: [`http.log.access.${ACCESS_LOGGER}`],
                    writer: { filename: input.accessLogPath, output: "file", roll_keep: 2, roll_size_mb: 20 },
                },
            },
        },
    };
};

/** Whether Caddy may get a certificate for `domain`: a routed hostname, or the box's own. */
const askApproves = (domain: string, routes: ReadonlyArray<RouteEntry>, hostname: string): boolean =>
    domain === hostname || routes.some((route) => route.hostname === domain);

interface CaddyControllerOptions {
    caddy: CaddyConfig;
    dataDir: string;
    /** Injected for tests. */
    fetch?: typeof fetch;
    hostname: string;
    logger: Logger;
}

/** Keeps Caddy's loaded config equal to the routing table, and serves its `ask` endpoint. */
class CaddyController {
    /** Where the last applied config is written — what Caddy starts from after a restart. */
    public readonly configPath: string;

    public readonly accessLogPath: string;

    /** Why Caddy refused the last config, until one loads. Shown by `diagnose`. */
    public lastError: string | undefined;

    private applied: string | undefined;

    private routes: ReadonlyArray<RouteEntry> = [];

    private server: Server | undefined;

    private readonly options: CaddyControllerOptions;

    public constructor(options: CaddyControllerOptions) {
        this.options = options;
        this.configPath = join(options.dataDir, "caddy", "caddy.json");
        this.accessLogPath = join(options.dataDir, "caddy", "access.log");
    }

    /** Build the config for `routes` and `ports`. */
    public build(routes: ReadonlyArray<RouteEntry>, ports: ReadonlyMap<string, number>): Json {
        return buildCaddyConfig({ accessLogPath: this.accessLogPath, caddy: this.options.caddy, hostname: this.options.hostname, ports, routes });
    }

    /** Write the config Caddy boots from, before it is started. */
    public writeBootConfig(routes: ReadonlyArray<RouteEntry>, ports: ReadonlyMap<string, number>): void {
        this.routes = routes;
        writeFileAtomic(this.configPath, `${JSON.stringify(this.build(routes, ports), undefined, 4)}\n`, 0o640);
    }

    /**
     * Load the config for `routes` into Caddy when it differs from the last one
     * loaded. A refusal keeps the previous config serving.
     * @returns whether Caddy now serves this table
     */
    public async apply(routes: ReadonlyArray<RouteEntry>, ports: ReadonlyMap<string, number>): Promise<boolean> {
        // The ask gate follows the table at once; a stale config never widens it.
        this.routes = routes;

        const config = this.build(routes, ports);
        const serialized = JSON.stringify(config);

        if (serialized === this.applied) {
            return true;
        }

        const fetcher = this.options.fetch ?? globalThis.fetch;
        let response: Response;

        try {
            response = await fetcher(`http://${this.options.caddy.adminAddress}/load`, {
                body: serialized,
                // Node's fetch sends `Sec-Fetch-Mode`, and Caddy then enforces the
                // admin API's origin check: without its own origin, every load is a 403.
                headers: { "content-type": "application/json", origin: `http://${this.options.caddy.adminAddress}` },
                method: "POST",
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            this.lastError = `caddy admin API unreachable: ${(error as Error).message}`;

            return false;
        }

        if (!response.ok) {
            const reason = await response.text();

            this.lastError = `caddy refused the config (${String(response.status)}): ${reason.slice(0, 2000)}`;
            this.options.logger.warn(this.lastError);

            return false;
        }

        await response.body?.cancel();
        this.applied = serialized;
        this.lastError = undefined;
        writeFileAtomic(this.configPath, `${JSON.stringify(config, undefined, 4)}\n`, 0o640);

        return true;
    }

    /** Serve the on-demand-TLS permission check on the loopback `askAddress`. */
    public async listenAsk(): Promise<void> {
        const [host, port] = this.options.caddy.askAddress.split(":") as [string, string];

        this.server = createServer((request, response) => {
            const [pathname, query = ""] = (request.url ?? "/").split("?", 2) as [string, string?];
            const domain = (new URLSearchParams(query).get("domain") ?? "").toLowerCase();
            const ok = pathname === "/ask" && askApproves(domain, this.routes, this.options.hostname);

            response.writeHead(ok ? 200 : 403, { "content-type": "text/plain" }).end(ok ? "ok\n" : "not routed\n");
        });

        await new Promise<void>((resolve, reject) => {
            this.server?.once("error", reject);
            this.server?.listen(Number(port), host, () => {
                resolve();
            });
        });
    }

    public async close(): Promise<void> {
        await new Promise<void>((resolve) => {
            if (this.server === undefined) {
                resolve();

                return;
            }

            this.server.close(() => {
                resolve();
            });
        });
    }
}

export type { CaddyBuildInput, CaddyControllerOptions };
export { askApproves, buildCaddyConfig, CaddyController, COMPRESSIBLE_TYPES, RATE_LIMIT };
