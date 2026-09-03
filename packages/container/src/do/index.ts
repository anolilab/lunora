/**
 * `@lunora/container/do` — the workerd-only half of the package.
 *
 * `@cloudflare/containers` imports `cloudflare:workers` at module scope, so
 * anything touching it lives behind this subpath: the package root stays
 * importable from Node tooling (codegen, config, app unit tests) while the
 * generated `_generated/containers.ts` imports the base class from here.
 */
import type { StopParams } from "@cloudflare/containers";
import { Container } from "@cloudflare/containers";
import { LunoraError } from "@lunora/errors";

import { abortDeadline } from "../../../../shared/abort-deadline";
import { parseDurationSeconds, resolveContainerEnvVars as resolveContainerEnvVariables } from "../define-container";
import { emitContainerLifecycle } from "../lifecycle-event";
import type { ContainerDefinition, ContainerReadinessCheck } from "../types";
import type { DurableObjectJurisdiction } from "./report-lifecycle";
import { reportContainerLifecycle } from "./report-lifecycle";

type DurableObjectContext = ConstructorParameters<typeof Container>[0];

/** Interval between `readyOn` probe attempts while waiting for the app to come up. */
const READINESS_POLL_INTERVAL_MS = 500;

/** Upper bound on how long the `readyOn` probes block container start before failing. */
const READINESS_TIMEOUT_MS = 30_000;

/**
 * Durable-storage key holding a monotonically-increasing "run generation". Each
 * start bumps it and stamps the `hardTimeout` schedule with the new value, so a
 * stale schedule left over from a previous run (the container slept or crashed,
 * then restarted) is recognised and ignored instead of killing the fresh run.
 */
const HARD_TIMEOUT_GENERATION_KEY = "__lunoraHardTimeoutGeneration";

/**
 * Base class for the generated Container DO classes. Applies a
 * `defineContainer` definition onto `@cloudflare/containers`' `Container`:
 * port, sleep timeout, internet access, and the container environment (static
 * `env` merged with the declared Worker secrets — a declared-but-unset secret
 * fails fast here rather than starting a container without its credential).
 *
 * Generated subclasses stay one line of behavior:
 *
 * ```ts
 * export class TranscoderContainer extends LunoraContainer {
 *     constructor(ctx: DurableObjectState, env: Env) {
 *         super(ctx, env, transcoder, "transcoder");
 *     }
 * }
 * ```
 */
class LunoraContainer<Env = unknown> extends Container<Env> {
    /**
     * Data-residency jurisdiction the app's DOs are pinned to (codegen passes the
     * schema's `.jurisdiction("…")`). Used to pin the best-effort lifecycle report
     * to the same region as the root shard. `undefined` ⇒ un-pinned.
     */
    private readonly lunoraJurisdiction?: DurableObjectJurisdiction;
    /** The `lunora/containers.ts` export name, for lifecycle log correlation. */
    private readonly lunoraName: string;
    /** Default port the readiness probes target when a check omits its own `port`. */
    private readonly lunoraDefaultPort?: number;
    /** Hard-cap lifetime in whole seconds (from the `hardTimeout` config), or `undefined`. */
    private readonly lunoraHardTimeoutSeconds?: number;
    /** Declarative readiness probes that gate request proxying (from the `readyOn` config). */
    private readonly lunoraReadyOn: ReadonlyArray<ContainerReadinessCheck>;
    /** Map of container env-var name → Worker Secrets Store binding name (from the `secretsStore` config). */
    private readonly lunoraSecretsStore?: Readonly<Record<string, string>>;
    /** Memoised Secrets Store resolution: run once, then merged into `envVars` before the first start. */
    private lunoraSecretsStoreResolved?: Promise<void>;

    public constructor(
        context: DurableObjectContext,
        env: Env,
        definition: ContainerDefinition,
        exportName?: string,
        jurisdiction?: DurableObjectJurisdiction,
    ) {
        super(context, env, {
            defaultPort: definition.defaultPort,
            entrypoint: definition.entrypoint ? [...definition.entrypoint] : undefined,
            envVars: resolveContainerEnvVariables(definition, env as Record<string, unknown>, exportName),
            sleepAfter: definition.sleepAfter,
        });

        if (definition.enableInternet !== undefined) {
            this.enableInternet = definition.enableInternet;
        }

        // Multi-port + egress-firewall fields are `Container` instance
        // properties (not constructor options), applied here from the
        // definition. Each is guarded so an un-set field leaves the
        // `@cloudflare/containers` default in place.
        if (definition.requiredPorts !== undefined) {
            this.requiredPorts = [...definition.requiredPorts];
        }

        if (definition.interceptHttps !== undefined) {
            this.interceptHttps = definition.interceptHttps;
        }

        if (definition.allowedHosts !== undefined) {
            this.allowedHosts = [...definition.allowedHosts];
        }

        if (definition.deniedHosts !== undefined) {
            this.deniedHosts = [...definition.deniedHosts];
        }

        if (definition.pingEndpoint !== undefined) {
            this.pingEndpoint = definition.pingEndpoint;
        }

        if (definition.labels !== undefined) {
            this.labels = { ...definition.labels };
        }

        this.lunoraName = exportName ?? "container";
        this.lunoraJurisdiction = jurisdiction;
        this.lunoraDefaultPort = definition.defaultPort;
        this.lunoraReadyOn = definition.readyOn ? [...definition.readyOn] : [];
        this.lunoraHardTimeoutSeconds = definition.hardTimeout === undefined ? undefined : parseDurationSeconds(definition.hardTimeout);
        this.lunoraSecretsStore = definition.secretsStore;
    }

    /**
     * Proxy entry for every `ctx.containers.<name>` fetch. Resolves the
     * `secretsStore` bindings into `envVars` before delegating, so the values
     * are present when the base implicitly starts the container for this
     * request — a no-op when `secretsStore` is unset.
     */
    public override async containerFetch(...args: Parameters<Container<Env>["containerFetch"]>): Promise<Response> {
        await this.resolveSecretsStoreEnv();

        return super.containerFetch(...args);
    }

    /**
     * The start path `containerFetch` takes (and the one an app can call itself).
     * The base's last act is `blockConcurrencyWhile(… onStart())`, so this
     * override resumes on the far side of that gate — which is where
     * {@link afterContainerStart} has to run. See its docblock.
     */
    public override async startAndWaitForPorts(...args: Parameters<Container<Env>["startAndWaitForPorts"]>): Promise<void> {
        await super.startAndWaitForPorts(...args);

        await this.afterContainerStart();
    }

    /**
     * Explicit start (`ctx.containers.<name>.get(id).start()`). Resolves the
     * `secretsStore` bindings into `envVars` first, mirroring
     * {@link containerFetch}. A per-instance `start({ envVars })` replaces the
     * env set wholesale (base behavior), so the injected values only apply to a
     * bare `start()` — same as the static `env`/`secrets`. When the caller
     * supplies its own `envVars` we skip resolution entirely: those values would
     * be discarded anyway, so a missing/unreadable binding shouldn't fail a start
     * that never uses them.
     */
    public override async start(...args: Parameters<Container<Env>["start"]>): Promise<void> {
        const [options] = args;

        if (options?.envVars === undefined) {
            await this.resolveSecretsStoreEnv();
        }

        await super.start(...args);

        await this.afterContainerStart();
    }

    public override async onActivityExpired(): Promise<void> {
        // The container slept after its `sleepAfter` idle window elapsed with no
        // proxied request or WebSocket frame. Surfacing it in the dev log +
        // Studio turns a silent disappearance into an observable event.
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "sleep");

        this.surfaceInStudioLogs(envelope);

        await super.onActivityExpired();
    }

    public override onError(error: unknown): unknown {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "error", error instanceof Error ? error.message : String(error));

        this.surfaceInStudioLogs(envelope);

        return super.onError(error);
    }

    public override async onStart(): Promise<void> {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "start");

        this.surfaceInStudioLogs(envelope);

        await super.onStart();
    }

    /**
     * Hook run when the container's `hardTimeout` elapses (dispatched by the base
     * scheduler via the run-generation-stamped schedule armed in
     * {@link onStart}). Default: stop the instance. Override to drain/checkpoint
     * first. A stale schedule from a previous run, or an already-stopped
     * instance, is ignored (upstream cloudflare/containers#85).
     */
    public async onHardTimeoutExpired(payload?: { generation?: number }): Promise<void> {
        const current = await this.ctx.storage.get<number>(HARD_TIMEOUT_GENERATION_KEY);

        // Ignore a schedule left over from a previous run (the container slept or
        // crashed and restarted between arming and firing) — killing the fresh
        // run early would be a surprising, hard-to-debug shutdown.
        if (payload?.generation !== undefined && payload.generation !== current) {
            return;
        }

        if (this.ctx.container?.running !== true) {
            return;
        }

        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "stop", "hard timeout reached");

        this.surfaceInStudioLogs(envelope);

        await this.stop();
    }

    public override async onStop(parameters: StopParams): Promise<void> {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "stop", `${parameters.reason} (exit ${String(parameters.exitCode)})`);

        this.surfaceInStudioLogs(envelope);

        await super.onStop(parameters);
    }

    /**
     * Arm the hard timeout and block on the `readyOn` probes — the work that has
     * to happen once per real start, **outside** the base's start gate.
     *
     * It cannot live in `onStart`, which is the obvious home for it: the base
     * invokes that hook as `blockConcurrencyWhile(async () => { … onStart() })`
     * (`@cloudflare/containers`, both `start()` and `startAndWaitForPorts()`),
     * and workerd treats a *rejecting* `blockConcurrencyWhile` closure as
     * unrecoverable — it aborts the Durable Object, discards its in-memory state
     * and every hibernating socket on it, and flattens the error to a plain
     * `Error`. A readiness timeout is an ordinary, diagnosable failure: it must
     * surface as the `LunoraError` naming the check, the port and the budget,
     * not cost the object its life and arrive as an opaque message. (The same
     * reasoning, and the same settle-outside-the-gate remedy, is written up on
     * `ShardHost.runSerialized` in `@lunora/platform-cloudflare`.) A 30-second
     * wait also has no business inside a gate that blocks every other dispatch
     * to the object.
     *
     * Both start entry points call this immediately after `super`, so it still
     * runs once per start and still gates request proxying: `containerFetch`
     * starts through `startAndWaitForPorts` and only proxies once it returns, so
     * a throw here fails the request instead of forwarding it to an app that
     * never reported ready.
     */
    private async afterContainerStart(): Promise<void> {
        await this.armHardTimeout();
        await this.awaitContainerReadiness();
    }

    /**
     * Arm the hard-timeout kill via the base scheduler (so it integrates with
     * the container's own alarm machinery instead of fighting it). Bumps the run
     * generation and stamps the schedule with it, so {@link onHardTimeoutExpired}
     * can tell a fresh schedule from a stale one. No-op without a `hardTimeout`.
     */
    private async armHardTimeout(): Promise<void> {
        if (this.lunoraHardTimeoutSeconds === undefined) {
            return;
        }

        const generation = ((await this.ctx.storage.get<number>(HARD_TIMEOUT_GENERATION_KEY)) ?? 0) + 1;

        await this.ctx.storage.put(HARD_TIMEOUT_GENERATION_KEY, generation);
        await this.schedule(this.lunoraHardTimeoutSeconds, "onHardTimeoutExpired", { generation });
    }

    /**
     * Resolve the `secretsStore` bindings (async `.get()`) once and merge the
     * values into `envVars`, so they're present when the base starts the
     * container. Memoised on the first call — every later start reuses the
     * resolved promise. A missing binding or a non-string value fails fast (the
     * start surfaces the error), the same fail-closed stance the static
     * `secrets` resolution takes for a missing Worker secret. No-op without
     * `secretsStore`.
     */
    private async resolveSecretsStoreEnv(): Promise<void> {
        const secretsStore = this.lunoraSecretsStore;

        if (secretsStore === undefined) {
            return;
        }

        this.lunoraSecretsStoreResolved ??= (async () => {
            const workerEnv = this.env as Record<string, unknown>;
            const resolved: Record<string, string> = {};

            for (const [envName, binding] of Object.entries(secretsStore)) {
                const store = workerEnv[binding] as { get?: () => Promise<unknown> } | undefined;

                if (store === undefined || typeof store.get !== "function") {
                    throw new LunoraError(
                        "INTERNAL",
                        `container "${this.lunoraName}": secretsStore env "${envName}" points at binding "${binding}", which is not a Secrets Store binding on the Worker env. Add a \`secrets_store_secrets\` entry binding "${binding}".`,
                    );
                }

                // eslint-disable-next-line no-await-in-loop -- a handful of secrets resolved once at first start; sequencing keeps the failing name obvious.
                const value = await store.get();

                if (typeof value !== "string") {
                    throw new TypeError(
                        `container "${this.lunoraName}": Secrets Store binding "${binding}" (env "${envName}") did not resolve to a string value.`,
                    );
                }

                resolved[envName] = value;
            }

            this.envVars = { ...this.envVars, ...resolved };
        })().catch((error: unknown) => {
            // A transient Secrets Store failure (`store.get()` is a remote call)
            // must fail only *this* start — not poison the instance forever.
            // Clear the memo so the next start retries resolution instead of
            // replaying the cached rejection.
            this.lunoraSecretsStoreResolved = undefined;

            throw error;
        });

        await this.lunoraSecretsStoreResolved;
    }

    /**
     * Block until every `readyOn` probe responds with its expected status, or
     * throw once the readiness budget is spent. Probes run in parallel and hit
     * the container's TCP port directly (NOT `containerFetch`, which would
     * recurse back into the start path). No-op without `readyOn`.
     */
    private async awaitContainerReadiness(): Promise<void> {
        if (this.lunoraReadyOn.length === 0) {
            return;
        }

        const { container } = this.ctx;

        if (container === undefined) {
            return;
        }

        const deadline = Date.now() + READINESS_TIMEOUT_MS;

        await Promise.all(this.lunoraReadyOn.map(async (check) => this.awaitReadinessCheck(container, check, deadline)));
    }

    /** Poll one readiness probe until it returns its expected status or the shared deadline passes. */
    private async awaitReadinessCheck(
        container: NonNullable<DurableObjectContext["container"]>,
        check: ContainerReadinessCheck,
        deadline: number,
    ): Promise<void> {
        const port = check.port ?? this.lunoraDefaultPort;

        if (port === undefined) {
            throw new LunoraError(
                "INTERNAL",
                `container "${this.lunoraName}": readyOn check "${check.path}" has no port — set the check's \`port\` or the container \`defaultPort\`.`,
            );
        }

        const expectedStatus = check.status ?? 200;
        const path = check.path.startsWith("/") ? check.path : `/${check.path}`;
        const tcpPort = container.getTcpPort(port);

        for (;;) {
            // A container that accepts the TCP connection but never answers must not
            // hang this loop past the deadline — bound each attempt with an abort
            // signal, floored at one poll interval so the final attempt still gets a
            // fair window instead of an near-instant abort.
            const attemptTimeoutMs = Math.max(READINESS_POLL_INTERVAL_MS, deadline - Date.now());
            // Per-attempt deadline via `shared/abort-deadline.ts` (explicit
            // controller + timer, strongly held) rather than the weakly-held
            // `AbortSignal.timeout` — see its docstring. Disposed after every
            // attempt so a fast probe leaves no pending timer behind.
            const attemptDeadline = abortDeadline(
                undefined,
                attemptTimeoutMs,
                () => new DOMException(`readiness probe timed out after ${String(attemptTimeoutMs)}ms`, "TimeoutError"),
            );

            try {
                // eslint-disable-next-line no-await-in-loop -- sequential poll: each probe waits on the previous attempt before retrying.
                const response = await tcpPort.fetch(`http://container${path}`, { signal: attemptDeadline.signal });

                if (response.status === expectedStatus) {
                    return;
                }
            } catch {
                // Connection refused, app not up yet, or the attempt timed out — fall through and retry below.
            } finally {
                attemptDeadline.dispose();
            }

            if (Date.now() >= deadline) {
                throw new LunoraError(
                    "INTERNAL",
                    `container "${this.lunoraName}": readiness check "${check.path}" (port ${String(port)}) did not return ${String(expectedStatus)} within ${String(READINESS_TIMEOUT_MS)}ms`,
                );
            }

            // eslint-disable-next-line no-await-in-loop -- back-off between poll attempts is intentionally sequential.
            await new Promise((resolve) => {
                setTimeout(resolve, READINESS_POLL_INTERVAL_MS);
            });
        }
    }

    /**
     * Best-effort push of `envelope` into the root ShardDO's log buffer so it
     * also appears in the Studio Logs panel (the terminal already has it via
     * `emitContainerLifecycle`). Fire-and-forget and fully swallowed: a missing
     * `SHARD` binding, a missing admin token, or a fetch failure NEVER throws
     * out of a lifecycle hook — the `console` path stays the source of truth.
     */
    private surfaceInStudioLogs(envelope: ReturnType<typeof emitContainerLifecycle>): void {
        // Fire-and-forget. `reportContainerLifecycle` already swallows every
        // failure internally; the trailing `.catch` is belt-and-suspenders so a
        // rejected promise can never become an unhandled rejection out of a hook.
        reportContainerLifecycle(this.env, envelope, this.lunoraJurisdiction).catch(() => {});
    }

    /**
     * Per-instance correlation id: the Durable Object id, which Cloudflare also
     * injects into the container as `CLOUDFLARE_DURABLE_OBJECT_ID`. Read
     * defensively — the id shape varies and isn't worth crashing a hook over.
     */
    private instanceId(): string {
        try {
            const { id } = this.ctx as { id?: { toString: () => string } };

            return typeof id?.toString === "function" ? id.toString() : "unknown";
        } catch {
            return "unknown";
        }
    }
}

export { LunoraContainer };
// Re-exported so the generated `_generated/containers.ts` can surface it from the
// worker entry: the `Container` outbound-interception path (egress allow/deny
// lists, `interceptHttps`, runtime egress controls) routes container traffic
// through this WorkerEntrypoint, which the deployed worker must therefore export.
// Funneling it through `@lunora/container/do` keeps the app depending only on
// `@lunora/container`, never on `@cloudflare/containers` directly.
export { ContainerProxy } from "@cloudflare/containers";
// Custom outbound-interception handlers (cloudflare/containers#135). These let a
// subclass of `LunoraContainer` rewrite/route a container's egress in worker
// code (e.g. inject auth, mock an upstream, enforce a proxy). They're worker-side
// functions, so they don't fit the data-only `defineContainer` config — surface
// the upstream types/helper here so an advanced app can wire them on its own
// generated subclass without depending on `@cloudflare/containers` directly.
export type { OutboundHandler, OutboundHandlerContext, OutboundHandlerParams, OutboundHandlerParamsOf, OutboundHandlers } from "@cloudflare/containers";
export { outboundParams } from "@cloudflare/containers";
