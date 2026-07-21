/**
 * Health / readiness probe routes (plan 177), built on the same admin-route
 * injection pattern as `./data-movement-admin-routes` and friends. Two public
 * endpoints back an uptime monitor, a load balancer, or a Cloudflare Health Check.
 * `GET /_lunora/health` is the aggregate probe: it runs every registered check and
 * returns `200` when all critical dependencies resolve, `503` when any critical
 * dependency is down (a non-critical failure degrades the reported `status` to
 * `"degraded"` but keeps the `200`, since the deployment still serves traffic).
 * `GET /_lunora/health/ready` is the readiness gate: it runs only the readiness
 * checks, which a load balancer polls to decide whether to route traffic.
 *
 * The registry itself is `@visulima/health-check`'s `HealthCheck` class — a pure,
 * dependency-free scheduler (`addChecker` / `getReport` / `isLive`) that is
 * edge-safe on workerd. Its bundled Node checkers (disk/dns/ping/memory) are NOT
 * imported; Lunora ships its own edge-safe binding probes instead.
 *
 * Security posture (plan 177 exit criteria): the body leaks NO secrets or PII. A
 * probe returns only a boolean and a message string the runtime controls — never
 * an env value, connection string, or binding name from user config. In the
 * default `"public"` posture the per-check `message` is omitted entirely; in the
 * `"admin"` posture the endpoint is bearer-gated AND the (still runtime-authored)
 * messages are included to aid an operator.
 */
import { HealthCheck } from "@visulima/health-check";

import { LunoraError } from "./errors";

const HEALTH_PATH = "/_lunora/health";
const HEALTH_READY_PATH = "/_lunora/health/ready";

/** Which probe(s) a check participates in. `both` (the default) runs on the aggregate probe and the readiness gate. */
type HealthProbeKind = "both" | "liveness" | "readiness";

/** The verdict a single probe returns. `message` is runtime-authored and must never echo a secret, env value, or user binding name. */
interface HealthProbeResult {
    healthy: boolean;
    /** Optional runtime-authored detail (e.g. "binding unreachable"). Included only in the `admin` posture. */
    message?: string;
}

/** One registered health check over a binding or subsystem. */
interface HealthProbe {
    /**
     * The async probe. It must be cheap and self-contained; a thrown error is
     * treated as an unhealthy result (fail-closed) so a probe bug never 500s the
     * endpoint.
     */
    check: () => Promise<HealthProbeResult> | HealthProbeResult;

    /**
     * A critical dependency flips the aggregate `/_lunora/health` probe to `503`
     * when unhealthy. A non-critical one only degrades the reported status.
     */
    critical?: boolean;
    /** Which probe(s) this check runs on. Defaults to `"both"`. */
    kind?: HealthProbeKind;
    /** Stable check name surfaced in the report (e.g. `"durable-object"`, `"d1"`). Not a secret. */
    name: string;
}

/** Auth posture for the health endpoints. `"public"` (default) is unauthenticated + message-redacted; `"admin"` requires a valid admin bearer. */
type HealthAuthPosture = "admin" | "public";

/** One check's line in the response body. */
interface HealthCheckReport {
    critical: boolean;
    /** Present only in the `admin` posture. */
    message?: string;
    name: string;
    status: "down" | "up";
}

/** The health response body. Deliberately minimal — status, per-check up/down, and static app metadata only. */
interface HealthBody {
    appName: string;
    appVersion: string;
    checks: HealthCheckReport[];
    status: "degraded" | "healthy" | "unhealthy";
    timestamp: string;
}

/** Injected dependencies for the health routes. Probes are resolved per-request so they can read the invocation `env` (bindings only exist at request time). */
interface HealthRouteDeps {
    /** Static application name surfaced in the body. Not a secret. */
    appName?: string;
    /** Static application version surfaced in the body. Not a secret. */
    appVersion?: string;
    /** Auth posture. Defaults to `"public"`. */
    auth?: HealthAuthPosture;

    /**
     * Cache the last computed report for this many ms so an orchestrator polling
     * every few seconds does not hammer the bindings. Defaults to `0` (no cache).
     */
    cacheTtlMs?: number;
    /** Admin-bearer predicate, consulted only when `auth === "admin"`. */
    isAdmin: (request: Request) => boolean;

    /**
     * Resolve the probes for this invocation from its `env`. Called once per
     * request; the returned probes are registered on a fresh `HealthCheck`
     * registry so the report reflects the live bindings.
     */
    resolveProbes: (env: unknown) => ReadonlyArray<HealthProbe>;
}

/** Map a {@link HealthProbeKind} to the `@visulima/health-check` checker `type` set (always an array for a single consistent return type). */
const toCheckerType = (kind: HealthProbeKind | undefined): ("liveness" | "readiness")[] => {
    if (kind === "liveness") {
        return ["liveness"];
    }

    if (kind === "readiness") {
        return ["readiness"];
    }

    return ["liveness", "readiness"];
};

/** Build a fresh registry from the resolved probes. A new registry per request keeps the check set aligned with the live `env`. */
const buildRegistry = (probes: ReadonlyArray<HealthProbe>, cacheTtlMs: number): { criticalNames: Set<string>; registry: HealthCheck } => {
    const registry = new HealthCheck({ cacheTtl: cacheTtlMs });
    const criticalNames = new Set<string>();

    for (const probe of probes) {
        if (probe.critical) {
            criticalNames.add(probe.name);
        }

        registry.addChecker(
            probe.name,
            async () => {
                // Fail-closed: any thrown error is reported as unhealthy rather
                // than escaping to a 500. The registry itself also guards against
                // throws, but normalising here keeps the message runtime-authored.
                let result: HealthProbeResult;

                try {
                    result = await probe.check();
                } catch (error: unknown) {
                    result = { healthy: false, message: error instanceof Error ? error.message : "probe failed" };
                }

                return {
                    displayName: probe.name,
                    health: {
                        healthy: result.healthy,
                        ...(result.message === undefined ? {} : { message: result.message }),
                        timestamp: new Date().toISOString(),
                    },
                };
            },
            { type: toCheckerType(probe.kind) },
        );
    }

    return { criticalNames, registry };
};

/**
 * Assemble the sanitised response body from a registry report. In the `public`
 * posture the per-check `message` is dropped (only name + up/down survive), so
 * no runtime-authored detail — however benign — reaches an unauthenticated
 * caller. The overall `status` is `unhealthy` when any CRITICAL check is down
 * (drives the `503`), `degraded` when only non-critical checks are down, else
 * `healthy`.
 */
const buildBody = (
    report: Record<string, { health: { healthy: boolean; message?: string } }>,
    criticalNames: Set<string>,
    posture: HealthAuthPosture,
    appName: string,
    appVersion: string,
): { anyCriticalDown: boolean; body: HealthBody } => {
    const checks: HealthCheckReport[] = [];
    let anyCriticalDown = false;
    let anyDown = false;

    for (const [name, entry] of Object.entries(report)) {
        const critical = criticalNames.has(name);
        const up = entry.health.healthy;

        if (!up) {
            anyDown = true;

            if (critical) {
                anyCriticalDown = true;
            }
        }

        checks.push({
            critical,
            ...(posture === "admin" && entry.health.message !== undefined ? { message: entry.health.message } : {}),
            name,
            status: up ? "up" : "down",
        });
    }

    // Stable ordering so a contract/snapshot never flakes on registry iteration order.
    checks.sort((a, b) => a.name.localeCompare(b.name));

    let status: HealthBody["status"] = "healthy";

    if (anyCriticalDown) {
        status = "unhealthy";
    } else if (anyDown) {
        status = "degraded";
    }

    return {
        anyCriticalDown,
        body: { appName, appVersion, checks, status, timestamp: new Date().toISOString() },
    };
};

/** Build the health + readiness route map merged into the worker's internal route table. */
const buildHealthRoutes = (deps: HealthRouteDeps): Record<string, (request: Request, env: unknown) => Promise<Response>> => {
    const { appName = "lunora", appVersion = "0.0.0", auth = "public", cacheTtlMs = 0, isAdmin, resolveProbes } = deps;

    const gate = (request: Request): void => {
        if (auth === "admin" && !isAdmin(request)) {
            throw new LunoraError("health endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }
    };

    const respond = async (request: Request, env: unknown, probeKind: "aggregate" | "readiness"): Promise<Response> => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response(undefined, { headers: { allow: "GET, HEAD" }, status: 405 });
        }

        gate(request);

        const { criticalNames, registry } = buildRegistry(resolveProbes(env), cacheTtlMs);
        const { healthy, report } = await registry.getReport(probeKind === "readiness" ? "readiness" : undefined);
        const { anyCriticalDown, body } = buildBody(report, criticalNames, auth, appName, appVersion);

        // The aggregate probe is `503` only when a CRITICAL dependency is down;
        // the readiness gate is `503` whenever any readiness check is unhealthy
        // (a load balancer should stop routing on any readiness failure).
        const down = probeKind === "readiness" ? !healthy : anyCriticalDown;

        return Response.json(body, { headers: { "cache-control": "no-store" }, status: down ? 503 : 200 });
    };

    return {
        [HEALTH_PATH]: (request, env) => respond(request, env, "aggregate"),
        [HEALTH_READY_PATH]: (request, env) => respond(request, env, "readiness"),
    };
};

/**
 * Structural probe of a Durable Object namespace's reachability: resolve the
 * default shard stub and issue a cheap request. ANY response (even a `404` for
 * an unknown path) proves the DO answered; only a thrown error means the object
 * is unreachable. Never inspects the response body, so it cannot leak state.
 */
const durableObjectProbe = (name: string, namespace: { get: (id: unknown) => { fetch: (request: Request) => Promise<Response> }; idFromName: (id: string) => unknown; }, shardKey: string): HealthProbe => {return {
    check: async () => {
        try {
            const stub = namespace.get(namespace.idFromName(shardKey));

            await stub.fetch(new Request("https://shard.internal/_lunora/status", { method: "GET" }));

            return { healthy: true };
        } catch {
            return { healthy: false, message: "durable object unreachable" };
        }
    },
    critical: true,
    name,
}};

/**
 * Active probe of a D1 database: run `SELECT 1`. Healthy when it resolves. The
 * binding is passed structurally (only `.prepare().first()` is used) so the
 * runtime stays free of a hard `@cloudflare/workers-types` dependency.
 */
const d1Probe = (name: string, database: { prepare: (sql: string) => { first: () => Promise<unknown> } }): HealthProbe => {return {
    check: async () => {
        try {
            await database.prepare("SELECT 1").first();

            return { healthy: true };
        } catch {
            return { healthy: false, message: "d1 query failed" };
        }
    },
    critical: true,
    name,
}};

/**
 * Presence check for a binding whose remote health cannot be probed cheaply (R2,
 * queues, Hyperdrive). A bound, well-shaped value reports healthy; the check does
 * NOT perform a billable remote op. Non-critical by default: a presence gap
 * degrades the status without forcing a `503`.
 */
const presenceProbe = (name: string, bound: boolean): HealthProbe => {return {
    check: () => (bound ? { healthy: true } : { healthy: false, message: "binding not configured" }),
    critical: false,
    name,
}};

export type { HealthAuthPosture, HealthBody, HealthCheckReport, HealthProbe, HealthProbeKind, HealthProbeResult, HealthRouteDeps };
export { buildHealthRoutes, d1Probe, durableObjectProbe, HEALTH_PATH, HEALTH_READY_PATH, presenceProbe };
