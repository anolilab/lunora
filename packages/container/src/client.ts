/**
 * The `ctx.containers` action surface: typed handles over the `CONTAINER_*`
 * Durable Object namespace bindings the config layer reconciles.
 *
 * Deliberately structural (no `@cloudflare/containers` import): a Durable
 * Object namespace stub is all that is needed to route a request to a
 * container-enabled DO, so this module stays Node-safe and the test double
 * below can satisfy the exact same shape without a workerd runtime.
 */

/** Options for explicitly starting an instance (mirrors `@cloudflare/containers`). */
interface ContainerStartOptions {
    /** Override outbound internet access for this start. */
    enableInternet?: boolean;
    /** Override the container entrypoint. */
    entrypoint?: string[];
    /** Per-instance environment, merged over the definition's `env`/secrets. */
    envVars?: Record<string, string>;
    /** Metadata labels attached for metrics/observability. */
    labels?: Record<string, string>;
}

/** A container instance's runtime state, as returned by `getState()`. Structural — the platform adds fields over time. */
interface ContainerInstanceState {
    [key: string]: unknown;
    lastChange?: number;
}

/** What a handle needs from a Durable Object stub — `fetch` plus the optional lifecycle/egress RPCs the container DO exposes. */
interface ContainerStubLike {
    allowHost?: (hostname: string) => Promise<void>;
    denyHost?: (hostname: string) => Promise<void>;
    destroy?: () => Promise<void>;
    fetch: (input: Request) => Promise<Response>;
    getState?: () => Promise<ContainerInstanceState>;
    removeAllowedHost?: (hostname: string) => Promise<void>;
    removeDeniedHost?: (hostname: string) => Promise<void>;
    renewActivityTimeout?: () => Promise<void>;
    setAllowedHosts?: (hosts: string[]) => Promise<void>;
    setDeniedHosts?: (hosts: string[]) => Promise<void>;
    start?: (options?: ContainerStartOptions) => Promise<void>;
    stop?: (signal?: number | string) => Promise<void>;
}

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/** What the client needs from a Durable Object namespace binding. */
interface ContainerNamespaceLike {
    get: (id: unknown) => ContainerStubLike;
    idFromName: (name: string) => unknown;

    /**
     * Derive a jurisdiction-restricted subnamespace. Optional because older
     * workers-types releases (and test doubles) may not expose it.
     */
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ContainerNamespaceLike;
}

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured. Fail-closed when the binding
 * lacks `.jurisdiction()` so a residency constraint is never silently dropped.
 */
const applyJurisdiction = (namespace: ContainerNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ContainerNamespaceLike => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/container: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

/** A handle on one container instance (one Durable Object). */
interface ContainerHandle {
    /**
     * Send an HTTP (or WebSocket-upgrade) request to the container. A path
     * string (`"/transcode"`) is resolved against a synthetic origin; a full
     * `Request`/URL passes through unchanged.
     */
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;

    /**
     * Return a handle that routes every request to `targetPort` on the
     * container instead of the definition's `defaultPort` — for multi-port
     * containers (declare the ports in `requiredPorts`). Sets the
     * `cf-container-target-port` header the way `@cloudflare/containers`'
     * `switchPort` does, so it composes with `.get()`, `.any()`, and `.pool()`:
     * `ctx.containers.app.get("u1").port(9090).fetch("/admin")`.
     */
    port: (targetPort: number) => ContainerHandle;
}

/**
 * A handle on a *named* instance (from `.get(name)`) — `fetch` plus explicit
 * lifecycle control. The per-entity pattern (a sandbox per user, a room per
 * game, a job runner per id) often needs to tear down or inspect the instance
 * rather than wait for `sleepAfter`, so these wrap the container DO's
 * `start`/`stop`/`destroy`/`getState`.
 */
interface ContainerInstanceHandle extends ContainerHandle {
    /** Stop and discard the instance (its ephemeral disk is lost). */
    destroy: () => Promise<void>;

    /**
     * Adjust this instance's egress allow/deny lists at runtime — the dynamic
     * counterpart to the static `allowedHosts`/`deniedHosts` config. Useful for
     * per-tenant egress policy. Requires the worker to export `ContainerProxy`
     * (codegen does this automatically when any container declares egress).
     */
    egress: ContainerEgressControls;
    /** Read the instance's current runtime state. */
    getState: () => Promise<ContainerInstanceState>;

    /**
     * Reset the instance's `sleepAfter` idle timer. The platform renews it on
     * each request automatically, but WebSocket message activity does not yet
     * renew it (cloudflare/containers#147) — call this on inbound WS traffic to
     * keep a busy socket's container awake.
     */
    renewActivityTimeout: () => Promise<void>;
    /** Explicitly start the instance, optionally with per-instance env/entrypoint. */
    start: (options?: ContainerStartOptions) => Promise<void>;
    /** Stop the instance (optionally with a signal); it can start again on the next request. */
    stop: (signal?: number | string) => Promise<void>;
}

/**
 * Runtime egress-firewall controls for a named instance (`handle.egress.*`).
 * Each maps to the corresponding `@cloudflare/containers` `Container` RPC, so
 * an app can tighten or relax a single instance's allowed/denied hosts after
 * start without redeploying.
 */
interface ContainerEgressControls {
    /** Add one hostname (or glob) to the allow-list. */
    allow: (hostname: string) => Promise<void>;
    /** Add one hostname (or glob) to the deny-list. */
    deny: (hostname: string) => Promise<void>;
    /** Remove one hostname from the allow-list. */
    removeAllowed: (hostname: string) => Promise<void>;
    /** Remove one hostname from the deny-list. */
    removeDenied: (hostname: string) => Promise<void>;
    /** Replace the entire allow-list. */
    setAllowed: (hosts: ReadonlyArray<string>) => Promise<void>;
    /** Replace the entire deny-list. */
    setDenied: (hosts: ReadonlyArray<string>) => Promise<void>;
}

/** The per-definition accessor exposed as `ctx.containers.&lt;exportName>`. */
interface ContainerAccessor {
    /**
     * A random instance from a fixed pool of `count` (defaults to the
     * definition's `maxInstances`, else 3 — mirroring `getRandom` from
     * `@cloudflare/containers`). For stateless, interchangeable workloads.
     */
    any: (count?: number) => ContainerHandle;
    /** The instance for `name` — one container per entity (user, room, job…), with lifecycle control. */
    get: (name: string) => ContainerInstanceHandle;

    /**
     * A resilient handle over the pool: each `fetch` picks a random instance and,
     * on a thrown error or a retryable response (5xx by default), retries on a
     * freshly-picked instance with exponential backoff. Until Cloudflare ships
     * native autoscaling + health-aware routing this is the recommended way to
     * call a stateless container pool — it rides over a single cold/unhealthy
     * instance instead of failing the whole request.
     *
     * Because a retry re-issues the request, pass a **replayable** body — a path
     * string plus an `init.body` string/`ArrayBuffer` (re-created each attempt).
     * A pre-built `Request` carrying a stream body can only be sent once, so it
     * is not retry-safe here; use `.get()`/`.any()` for those.
     */
    pool: (options?: PoolOptions) => ContainerHandle;
}

/** Tuning for a pooled, retrying container handle. See {@link ContainerAccessor.pool}. */
interface PoolOptions {
    /** Total attempts before giving up (each on a freshly-picked instance). Default 3. */
    attempts?: number;
    /** Base backoff in ms between attempts; doubles each retry (0 disables the wait). Default 100. */
    backoffMs?: number;

    /**
     * Upper bound on a single backoff sleep, in ms. The doubling delay is clamped
     * to this ceiling so a large `attempts` count can't produce an unboundedly
     * long wait. Default {@link DEFAULT_MAX_BACKOFF_MS} (30s).
     */
    maxBackoffMs?: number;

    /**
     * Whether a *returned* response should be retried on another instance.
     * Defaults to retrying any `5xx`. A thrown error (network/start failure) is
     * always retried regardless of this predicate.
     */
    retryOn?: (response: Response) => boolean;
    /** Pool size to spread picks across. Defaults to the definition's `maxInstances`, else 3. */
    size?: number;
}

/** Wiring info for one definition, emitted by codegen into the generated DO. */
interface ContainerBindingSpec {
    /** Durable Object binding name, e.g. `CONTAINER_TRANSCODER`. */
    binding: string;
    /** The `lunora/containers.ts` export name, e.g. `transcoder`. */
    exportName: string;
    /** Pool size default for `.any()`. */
    maxInstances?: number;
}

/**
 * Mirror of `getRandom`'s default pool size in `@cloudflare/containers`, used
 * when a definition declares no `maxInstances`.
 */
const DEFAULT_POOL_SIZE = 3;

/**
 * Default ceiling for a single pool-retry backoff sleep. Caps the exponential
 * doubling so a large `attempts` count can't yield an unboundedly long wait.
 */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** The header `@cloudflare/containers`' `switchPort` sets to target a non-default container port. */
const TARGET_PORT_HEADER = "cf-container-target-port";

const toRequest = (input: Request | string, init?: RequestInit, port?: number): Request => {
    const request = typeof input === "string" && input.startsWith("/") ? new Request(`http://container${input}`, init) : new Request(input, init);

    if (port !== undefined) {
        request.headers.set(TARGET_PORT_HEADER, String(port));
    }

    return request;
};

/**
 * A fetch-only handle over a `send` function, carrying an optional target port.
 * `.port(n)` re-binds the same `send` to a different port, so multi-port
 * routing composes uniformly across `.get()`, `.any()`, and `.pool()`.
 */
const sendingHandle = (send: (request: Request) => Promise<Response>, port?: number): ContainerHandle => {
    return {
        fetch: async (input, init) => send(toRequest(input, init, port)),
        port: (targetPort) => sendingHandle(send, targetPort),
    };
};

const handleFor = (namespace: ContainerNamespaceLike, instanceName: string): ContainerHandle =>
    sendingHandle(async (request) => namespace.get(namespace.idFromName(instanceName)).fetch(request));

/** Lifecycle/egress RPCs `instanceHandleFor` forwards to the container DO stub. */
type ContainerStubMethod = keyof Omit<ContainerStubLike, "fetch">;

/** Invoke an optional lifecycle/egress RPC on a stub, with a directed error if the runtime doesn't expose it. */
const lifecycleCall = async <Result>(stub: ContainerStubLike, method: ContainerStubMethod, binding: string, argument?: unknown): Promise<Result> => {
    const rpc = stub[method];

    if (typeof rpc !== "function") {
        throw new TypeError(`ctx.containers: the "${binding}" container DO does not expose ${method}() — is @lunora/container/do up to date?`);
    }

    return (rpc as (argument?: unknown) => Promise<Result>)(argument);
};

/** A named-instance handle: `fetch`/`.port()` plus the container DO's lifecycle + egress RPCs. */
const instanceHandleFor = (namespace: ContainerNamespaceLike, spec: ContainerBindingSpec, instanceName: string): ContainerInstanceHandle => {
    const stub = (): ContainerStubLike => namespace.get(namespace.idFromName(instanceName));

    return {
        ...sendingHandle(async (request) => stub().fetch(request)),
        destroy: async () => lifecycleCall(stub(), "destroy", spec.binding),
        egress: {
            allow: async (hostname) => lifecycleCall(stub(), "allowHost", spec.binding, hostname),
            deny: async (hostname) => lifecycleCall(stub(), "denyHost", spec.binding, hostname),
            removeAllowed: async (hostname) => lifecycleCall(stub(), "removeAllowedHost", spec.binding, hostname),
            removeDenied: async (hostname) => lifecycleCall(stub(), "removeDeniedHost", spec.binding, hostname),
            setAllowed: async (hosts) => lifecycleCall(stub(), "setAllowedHosts", spec.binding, [...hosts]),
            setDenied: async (hosts) => lifecycleCall(stub(), "setDeniedHosts", spec.binding, [...hosts]),
        },
        getState: async () => lifecycleCall(stub(), "getState", spec.binding),
        renewActivityTimeout: async () => lifecycleCall(stub(), "renewActivityTimeout", spec.binding),
        start: async (options) => lifecycleCall(stub(), "start", spec.binding, options),
        stop: async (signal) => lifecycleCall(stub(), "stop", spec.binding, signal),
    };
};

/** A random pool-instance name in `[0, size)`. */
const randomPoolName = (size: number): string =>
    // eslint-disable-next-line sonarjs/pseudo-random -- load-balancing pick across interchangeable instances, not a security decision
    `pool-${String(Math.floor(Math.random() * size))}`;

const sleep = async (ms: number): Promise<void> => {
    if (ms <= 0) {
        return;
    }

    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

/** Default retry predicate: a server error (5xx) is worth another instance. */
const retryOnServerError = (response: Response): boolean => response.status >= 500;

/**
 * A pooled handle: each fetch picks a random instance, and on a thrown error or
 * a retryable response retries on a freshly-picked instance with exponential
 * backoff. Pure over the namespace, so it's testable with a fake. The final
 * attempt's outcome (response or thrown error) is returned/propagated as-is.
 */
const poolHandleFor = (namespace: ContainerNamespaceLike, spec: ContainerBindingSpec, options: PoolOptions = {}, port?: number): ContainerHandle => {
    const size = options.size ?? spec.maxInstances ?? DEFAULT_POOL_SIZE;
    const attempts = Math.max(1, options.attempts ?? 3);
    const baseBackoff = options.backoffMs ?? 100;
    const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const shouldRetry = options.retryOn ?? retryOnServerError;

    return {
        fetch: async (input, init) => {
            let lastError: unknown;

            for (let attempt = 0; attempt < attempts; attempt += 1) {
                if (attempt > 0) {
                    // Clamp the doubling delay to the ceiling so a high `attempts`
                    // value can't produce an unboundedly long sleep.
                    // eslint-disable-next-line no-await-in-loop -- sequential retry with backoff between attempts
                    await sleep(Math.min(baseBackoff * 2 ** (attempt - 1), maxBackoff));
                }

                const request = toRequest(input, init, port);

                try {
                    // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential
                    const response = await namespace.get(namespace.idFromName(randomPoolName(size))).fetch(request);

                    if (attempt === attempts - 1 || !shouldRetry(response)) {
                        return response;
                    }
                } catch (error: unknown) {
                    lastError = error;
                }
            }

            // Exhausted attempts after a thrown error on the last try.
            throw lastError instanceof Error ? lastError : new Error(`ctx.containers.${spec.exportName}.pool(): all ${String(attempts)} attempts failed`);
        },
        port: (targetPort) => poolHandleFor(namespace, spec, options, targetPort),
    };
};

const accessorFor = (namespace: ContainerNamespaceLike, spec: ContainerBindingSpec): ContainerAccessor => {
    return {
        any: (count) => handleFor(namespace, randomPoolName(count ?? spec.maxInstances ?? DEFAULT_POOL_SIZE)),
        get: (name) => instanceHandleFor(namespace, spec, name),
        pool: (options) => poolHandleFor(namespace, spec, options),
    };
};

/** Accessor used when the binding is absent: every call throws a directed error. */
const missingBindingAccessor = (spec: ContainerBindingSpec): ContainerAccessor => {
    const fail = (): never => {
        throw new Error(
            `ctx.containers.${spec.exportName}: no "${spec.binding}" Durable Object binding found. Run \`lunora dev\` (or \`lunora deploy\`) to reconcile wrangler.jsonc, and make sure the worker entry re-exports the generated container classes.`,
        );
    };

    return { any: fail, get: fail, pool: fail };
};

/**
 * Build the `ctx.containers` record from the Worker `env`. Called by the
 * generated ShardDO with the specs codegen derived from
 * `lunora/containers.ts`. A missing binding doesn't throw here — only when the
 * handle is actually used — so one unprovisioned container never breaks
 * unrelated functions.
 */
const createContainerContext = (
    env: Record<string, unknown>,
    specs: ReadonlyArray<ContainerBindingSpec>,
    jurisdiction?: DurableObjectJurisdiction,
): Record<string, ContainerAccessor> => {
    const containers: Record<string, ContainerAccessor> = {};

    for (const spec of specs) {
        const binding = env[spec.binding] as ContainerNamespaceLike | undefined;

        containers[spec.exportName] =
            binding && typeof binding.idFromName === "function" && typeof binding.get === "function"
                ? accessorFor(applyJurisdiction(binding, jurisdiction), spec)
                : missingBindingAccessor(spec);
    }

    return containers;
};

/** A test handler: receives the request plus the targeted instance name. */
type ContainerTestHandler = (request: Request, instance: { name: string }) => Promise<Response> | Response;

/**
 * Docker-free test double for `ctx.containers`: each export name maps to a
 * fetch handler that plays the container. Mirrors the real shape exactly, so
 * action handlers under test can't tell the difference.
 *
 * ```ts
 * const containers = createContainerTestContext({
 *     transcoder: (request) => new Response("ok"),
 * });
 * ```
 */
const createContainerTestContext = (handlers: Record<string, ContainerTestHandler>): Record<string, ContainerAccessor> => {
    const containers: Record<string, ContainerAccessor> = {};

    for (const [exportName, handler] of Object.entries(handlers)) {
        const testHandleFor = (instanceName: string, port?: number): ContainerHandle => {
            return {
                fetch: async (input, init) => handler(toRequest(input, init, port), { name: instanceName }),
                port: (targetPort) => testHandleFor(instanceName, targetPort),
            };
        };

        // Lifecycle/egress calls in the double are inert (resolve void / a stub
        // state) so action tests that stop/destroy/inspect/re-route an instance
        // don't blow up; the double exercises action logic, not real container
        // behavior.
        const testInstanceHandleFor = (instanceName: string): ContainerInstanceHandle => {
            return {
                ...testHandleFor(instanceName),
                destroy: () => Promise.resolve(),
                egress: {
                    allow: () => Promise.resolve(),
                    deny: () => Promise.resolve(),
                    removeAllowed: () => Promise.resolve(),
                    removeDenied: () => Promise.resolve(),
                    setAllowed: () => Promise.resolve(),
                    setDenied: () => Promise.resolve(),
                },
                getState: () => Promise.resolve({ lastChange: 0 }),
                renewActivityTimeout: () => Promise.resolve(),
                start: () => Promise.resolve(),
                stop: () => Promise.resolve(),
            };
        };

        containers[exportName] = {
            any: () => testHandleFor("pool-0"),
            get: (name) => testInstanceHandleFor(name),
            // The double doesn't simulate failure/retry — pool() just routes to
            // the handler like any other call, so tests stay deterministic.
            pool: () => testHandleFor("pool-0"),
        };
    }

    return containers;
};

export type {
    ContainerAccessor,
    ContainerBindingSpec,
    ContainerEgressControls,
    ContainerHandle,
    ContainerInstanceHandle,
    ContainerInstanceState,
    ContainerNamespaceLike,
    ContainerStartOptions,
    ContainerTestHandler,
    DurableObjectJurisdiction,
    PoolOptions,
};
export { createContainerContext, createContainerTestContext };
