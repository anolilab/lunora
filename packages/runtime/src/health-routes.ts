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
 * default `"public"` posture the per-check `message` is omitted entirely AND the
 * check `name` is reduced to its probe kind (`d1`, `r2`, …) so the operator's
 * real binding keys never reach an unauthenticated caller (see `buildBody`); in
 * the `"admin"` posture the endpoint is bearer-gated AND the (still
 * runtime-authored) messages plus the full `kind:key` names are included to aid
 * an operator.
 */
import { LunoraError } from "./errors";
import { methodGuard } from "./method-guard";
import type { ShardNamespaceLike } from "./resolve-shard";
import { resolveShard } from "./resolve-shard";

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
    /** The redacted probe kind (`d1`, `r2`, `d1#2`, …) in the `public` posture; the full `kind:key` name in `admin`. */
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
     * every few seconds does not hammer the bindings (each uncached request runs
     * a real Durable Object subrequest plus one `SELECT 1` per detected D1
     * binding, which an unauthenticated flood would otherwise amplify). Cached
     * independently for the aggregate and readiness probes, since their bodies
     * differ. When omitted it defaults to `5000` in the `public` posture and `0`
     * (no cache) in the bearer-gated `admin` posture.
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

    // `undefined`, `"both"`, and any value outside the union (untyped config)
    // all run both checkers — an unknown kind must not be handed raw to the
    // health-check library as a checker type it does not know.
    return ["liveness", "readiness"];
};

/** A single check's normalised result — `{ health }`, keyed by name in a {@link HealthReport}. */
type CheckerResult = { health: { healthy: boolean; message?: string } };

/** The aggregate of every run check: `healthy` is true only when all run checks are up. */
interface HealthReport {
    healthy: boolean;
    report: Record<string, CheckerResult>;
}

/**
 * Edge-safe, dependency-free health-check registry — a drop-in for the subset of
 * `@visulima/health-check`'s `HealthCheck` this module used (register → run →
 * aggregate). That package is NOT bundleable for workerd: its transitive
 * `pingman` dependency imports `node:process`, which breaks the worker build.
 * We only ever used it as a per-request container, so this ~20-line runner is a
 * faithful substitute. Checks run concurrently; `getReport(filter)` narrows to
 * the checkers whose `type` set includes the requested phase (readiness).
 */
class HealthRegistry {
    readonly #checkers = new Map<string, { run: () => Promise<CheckerResult>; types: ReadonlyArray<"liveness" | "readiness"> }>();

    public addChecker(name: string, run: () => Promise<CheckerResult>, options: { type: ReadonlyArray<"liveness" | "readiness"> }): void {
        this.#checkers.set(name, { run, types: options.type });
    }

    public async getReport(filter?: "readiness"): Promise<HealthReport> {
        const selected = [...this.#checkers].filter(([, checker]) => filter === undefined || checker.types.includes(filter));
        const entries = await Promise.all(selected.map(async ([name, checker]): Promise<[string, CheckerResult]> => [name, await checker.run()]));

        return {
            healthy: entries.every(([, result]) => result.health.healthy),
            report: Object.fromEntries(entries),
        };
    }
}

/** Build a fresh registry from the resolved probes. A new registry per request keeps the check set aligned with the live `env`. */
const buildRegistry = (probes: ReadonlyArray<HealthProbe>): { criticalNames: Set<string>; registry: HealthRegistry } => {
    const registry = new HealthRegistry();
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
                    health: {
                        healthy: result.healthy,
                        ...(result.message === undefined ? {} : { message: result.message }),
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
 * posture two things are redacted: the per-check `message` is dropped (only name
 * + up/down survive), and the check `name` is reduced to its probe KIND — the
 * name prefix up to the first `:` (`d1`, `r2`, `queue`, …) with a `#n`
 * disambiguator when a kind repeats. This keeps the operator's real binding keys
 * (`d1:BILLING_LEGACY`, `queue:PII_EXPORT`) out of an unauthenticated response,
 * where they would otherwise leak internal systems / environments / tenant
 * structure. The `admin` posture keeps the full `kind:key` names (Studio and
 * operators depend on their readability). The overall `status` is `unhealthy`
 * when any CRITICAL check is down (drives the `503`), `degraded` when only
 * non-critical checks are down, else `healthy`.
 */

/**
 * Public-posture name redaction: reduce a check name to its probe KIND — the part
 * before the first `:`. Auto-detected probes are `kind:key`, so this yields `d1`,
 * `r2`, … A custom probe name lacking a `:` (e.g. an operator-supplied
 * `acme-prod-billing`) has no safe kind prefix, so it collapses to a generic
 * `probe` label rather than leaking the raw name to an unauthenticated caller.
 * `kindCounts` is read and mutated so a repeated kind surfaces disambiguated
 * (`d1#2`) instead of colliding.
 */
const redactCheckName = (name: string, kindCounts: Map<string, number>): string => {
    const kind = name.includes(":") ? name.slice(0, name.indexOf(":")) : "probe";
    const seen = (kindCounts.get(kind) ?? 0) + 1;

    kindCounts.set(kind, seen);

    return seen === 1 ? kind : `${kind}#${String(seen)}`;
};

/** Roll the per-check up/down tally into the body's overall status: any critical down → `unhealthy` (drives the 503), any non-critical down → `degraded`, else `healthy`. */
const overallStatus = (anyCriticalDown: boolean, anyDown: boolean): HealthBody["status"] => {
    if (anyCriticalDown) {
        return "unhealthy";
    }

    if (anyDown) {
        return "degraded";
    }

    return "healthy";
};

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
    // Public-posture disambiguation: how many times each redacted kind has been
    // seen so far, so a second `d1` binding surfaces as `d1#2` rather than
    // colliding. Keyed by kind; unused in the admin posture.
    const kindCounts = new Map<string, number>();

    for (const [name, entry] of Object.entries(report)) {
        const critical = criticalNames.has(name);
        const up = entry.health.healthy;

        anyDown = anyDown || !up;
        anyCriticalDown = anyCriticalDown || (!up && critical);

        // Admin keeps the full `kind:key` name; the public posture redacts it.
        const reportedName = posture === "admin" ? name : redactCheckName(name, kindCounts);

        checks.push({
            critical,
            ...(posture === "admin" && entry.health.message !== undefined ? { message: entry.health.message } : {}),
            name: reportedName,
            status: up ? "up" : "down",
        });
    }

    // Stable ordering so a contract/snapshot never flakes on registry iteration
    // order. By UTF-16 CODE UNIT, not `localeCompare` — for the reason
    // `shared/rest-surface.ts` and `shared/schema-snapshot.ts`'s `sortKeys` both
    // spell out: `localeCompare` resolves against the runtime's default locale and
    // ICU version, so it is not stable across machines, which is the one property
    // the comment above claims. The names here carry `:` and `#`
    // (`d1`, `d1#2`, `durable-object:default`) — exactly where collation and
    // code-unit order diverge.
    checks.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));

    return {
        anyCriticalDown,
        body: { appName, appVersion, checks, status: overallStatus(anyCriticalDown, anyDown), timestamp: new Date().toISOString() },
    };
};

/** Build the health + readiness route map merged into the worker's internal route table. */
const buildHealthRoutes = (deps: HealthRouteDeps): Record<string, (request: Request, env: unknown) => Promise<Response>> => {
    const { appName = "lunora", appVersion = "0.0.0", auth = "public", cacheTtlMs, isAdmin, resolveProbes } = deps;

    // Cache the computed report so a frequent poller (and, more importantly, an
    // unauthenticated flood) does not re-run the live probes — a real Durable
    // Object subrequest plus one `SELECT 1` per detected D1 binding — on every
    // request. Keyed by probe kind because the aggregate and readiness endpoints,
    // though served under the same posture, produce different bodies. This closure
    // is built once per worker, so the cache persists across requests in the isolate.
    //
    // The DEFAULT TTL differs by probe kind. The aggregate probe defaults to
    // `5000` ms in the unauthenticated `public` posture (the amplification vector)
    // and `0` in the bearer-gated `admin` posture. The readiness gate defaults to
    // `0` (uncached) in BOTH postures: a load-balancer / k8s readiness poll must
    // observe a dependency going down on the very next poll, not up to 5s later.
    // An operator can still opt the readiness gate into caching by setting
    // `cacheTtlMs` explicitly, which overrides the default for both endpoints.
    const cacheTtlFor = (probeKind: "aggregate" | "readiness"): number => {
        if (cacheTtlMs !== undefined) {
            return cacheTtlMs;
        }

        if (probeKind === "readiness") {
            return 0;
        }

        return auth === "public" ? 5000 : 0;
    };
    const cache: Partial<Record<"aggregate" | "readiness", { body: HealthBody; down: boolean; expiresAt: number }>> = {};

    const gate = (request: Request): void => {
        if (auth === "admin" && !isAdmin(request)) {
            throw new LunoraError("health endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }
    };

    const respond = async (request: Request, env: unknown, probeKind: "aggregate" | "readiness"): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["GET", "HEAD"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        gate(request);

        const effectiveCacheTtlMs = cacheTtlFor(probeKind);

        if (effectiveCacheTtlMs > 0) {
            const hit = cache[probeKind];

            if (hit !== undefined && Date.now() < hit.expiresAt) {
                return Response.json(hit.body, { headers: { "cache-control": "no-store" }, status: hit.down ? 503 : 200 });
            }
        }

        const { criticalNames, registry } = buildRegistry(resolveProbes(env));
        const { healthy, report } = await registry.getReport(probeKind === "readiness" ? "readiness" : undefined);
        const { anyCriticalDown, body } = buildBody(report, criticalNames, auth, appName, appVersion);

        // The aggregate probe is `503` only when a CRITICAL dependency is down;
        // the readiness gate is `503` whenever any readiness check is unhealthy
        // (a load balancer should stop routing on any readiness failure).
        const down = probeKind === "readiness" ? !healthy : anyCriticalDown;

        if (effectiveCacheTtlMs > 0) {
            cache[probeKind] = { body, down, expiresAt: Date.now() + effectiveCacheTtlMs };
        }

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
const durableObjectProbe = (name: string, namespace: ShardNamespaceLike, shardKey: string): HealthProbe => {
    return {
        check: async () => {
            try {
                const stub = resolveShard(namespace, shardKey);

                await stub.fetch(new Request("https://shard.internal/_lunora/status", { method: "GET" }));

                return { healthy: true };
            } catch {
                return { healthy: false, message: "durable object unreachable" };
            }
        },
        critical: true,
        name,
    };
};

/**
 * Active probe of a D1 database: run `SELECT 1`. Healthy when it resolves. The
 * binding is passed structurally (only `.prepare().first()` is used) so the
 * runtime stays free of a hard `@cloudflare/workers-types` dependency.
 */
const d1Probe = (name: string, database: { prepare: (sql: string) => { first: () => Promise<unknown> } }): HealthProbe => {
    return {
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
    };
};

/**
 * Presence check for a binding whose remote health cannot be probed cheaply (R2,
 * queues, Hyperdrive). A bound, well-shaped value reports healthy; the check does
 * NOT perform a billable remote op. Non-critical by default: a presence gap
 * degrades the status without forcing a `503`.
 */
const presenceProbe = (name: string, bound: boolean): HealthProbe => {
    return {
        check: () => (bound ? { healthy: true } : { healthy: false, message: "binding not configured" }),
        critical: false,
        name,
    };
};

export type { HealthAuthPosture, HealthBody, HealthCheckReport, HealthProbe, HealthProbeKind, HealthProbeResult, HealthRouteDeps };
export { buildHealthRoutes, d1Probe, durableObjectProbe, HEALTH_PATH, HEALTH_READY_PATH, presenceProbe };
