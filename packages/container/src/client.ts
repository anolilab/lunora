/**
 * The `ctx.containers` action surface: typed handles over the `CONTAINER_*`
 * Durable Object namespace bindings the config layer reconciles.
 *
 * Deliberately structural (no `@cloudflare/containers` import): a Durable
 * Object namespace stub is all that is needed to route a request to a
 * container-enabled DO, so this module stays Node-safe and the test double
 * below can satisfy the exact same shape without a workerd runtime.
 */
import { LunoraError } from "@lunora/errors";

import { containerBindingName } from "./define-container";
import type { DurableObjectJurisdiction } from "./jurisdiction";
import { applyJurisdiction } from "./jurisdiction";

/**
 * Options for explicitly starting an instance (mirrors `@cloudflare/containers`).
 * @experimental
 */
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

/**
 * A container instance's runtime state, as returned by `getState()`. Structural — the platform adds fields over time.
 * @experimental
 */
interface ContainerInstanceState {
    [key: string]: unknown;
    /** Process exit code, present once the instance has `stopped_with_code`. */
    exitCode?: number;
    /** Epoch-ms of the last state transition. */
    lastChange?: number;
    /** Lifecycle status. Widening union — Cloudflare adds values over time. */
    status?: "healthy" | "running" | "stopped" | "stopped_with_code" | "stopping";
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
 * What the client needs from a Durable Object namespace binding.
 * @experimental
 */
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
 * A handle on one container instance (one Durable Object).
 * @experimental
 */
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
 * @experimental
 */
interface ContainerInstanceHandle extends ContainerHandle {
    /** Stop and discard the instance (its ephemeral disk is lost). */
    destroy: () => Promise<void>;

    /**
     * Adjust this instance's egress allow/deny lists at runtime — the dynamic
     * counterpart to the static `allowedHosts`/`deniedHosts` config. Useful for
     * per-tenant egress policy. Requires the worker to export `ContainerProxy`
     * (codegen re-exports it from the generated container file whenever any
     * container is defined, so the runtime controls always work).
     */
    egress: ContainerEgressControls;
    /** Read the instance's current runtime state. */
    getState: () => Promise<ContainerInstanceState>;

    /**
     * Reset the instance's `sleepAfter` idle timer. The platform renews it on
     * each proxied request, and because `@lunora/container` proxies WebSocket
     * frames through the Durable Object, message traffic on an open socket
     * renews it too (the WebSocket-keepalive gap of cloudflare/containers#147 is
     * closed in the bundled base). This manual control is the escape hatch for
     * keeping a container awake during activity that is neither an HTTP request
     * nor a WS message — e.g. a long out-of-band job running inside it.
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
 * @experimental
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

/**
 * The per-definition accessor exposed as `ctx.containers.<exportName>`.
 * @experimental
 */
interface ContainerAccessor {
    /**
     * A random instance from a fixed pool of `count` (defaults to the
     * definition's `maxInstances`, else 3 — mirroring `getRandom` from
     * `@cloudflare/containers`). For stateless, interchangeable workloads.
     *
     * Like `.get()`, a path/URL-string fetch transparently retries the
     * cold-start "instance is provisioning" transients (cloudflare/containers#45,
     * #139); pass {@link InstanceRetryOptions} to tune or disable it.
     */
    any: (count?: number, options?: InstanceRetryOptions) => ContainerHandle;

    /**
     * The instance for `name` — one container per entity (user, room, job…),
     * with lifecycle control.
     *
     * A path/URL-string fetch transparently retries the platform's cold-start
     * transients — "there is no Container instance available" / "container is
     * not listening" while an instance is still provisioning
     * (cloudflare/containers#45, #139) — on the *same* instance with backoff,
     * since the request never reached the app. Pass {@link InstanceRetryOptions}
     * to tune attempts/backoff or disable it (`{ attempts: 1 }`). A pre-built
     * `Request` (possibly a one-shot stream body) is sent once, never retried.
     */
    get: (name: string, options?: InstanceRetryOptions) => ContainerInstanceHandle;

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

/**
 * Tuning for a pooled, retrying container handle. See {@link ContainerAccessor.pool}.
 * @experimental
 */
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

/**
 * Tuning for the cold-start retry on a `.get()`/`.any()` handle. The retry fires
 * only on the platform's provisioning transients (no-instance / not-listening /
 * rate-limited — see {@link isColdStartTransient}), which is why it's safe by
 * default: those responses mean the request never reached the container.
 * @experimental
 */
interface InstanceRetryOptions {
    /**
     * Total attempts on a cold-start transient before the last outcome is
     * surfaced as-is. `1` disables the retry. Default
     * {@link DEFAULT_COLD_START_ATTEMPTS}.
     */
    attempts?: number;
    /** Base backoff in ms between attempts; doubles each retry (0 disables the wait). Default {@link DEFAULT_COLD_START_BACKOFF_MS}. */
    backoffMs?: number;
    /** Upper bound on a single backoff sleep, in ms. Default {@link DEFAULT_MAX_BACKOFF_MS} (30s). */
    maxBackoffMs?: number;
}

/**
 * Wiring info for one definition, emitted by codegen into the generated DO.
 * @experimental
 */
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

/** Default attempts for the `.get()`/`.any()` cold-start retry (1 = disabled). */
const DEFAULT_COLD_START_ATTEMPTS = 3;

/**
 * Default base backoff for the cold-start retry. Larger than the pool default
 * because the wait is for an instance to *provision*, which is slower than the
 * load-balancing re-pick a pool retry does.
 */
const DEFAULT_COLD_START_BACKOFF_MS = 500;

/** The header `@cloudflare/containers`' `switchPort` sets to target a non-default container port. */
const TARGET_PORT_HEADER = "cf-container-target-port";

const toRequest = (input: Request | string, init?: RequestInit, port?: number, traceparent?: string): Request => {
    const request = typeof input === "string" && input.startsWith("/") ? new Request(`http://container${input}`, init) : new Request(input, init);

    if (port !== undefined) {
        request.headers.set(TARGET_PORT_HEADER, String(port));
    }

    if (traceparent !== undefined) {
        // Propagate the Worker RPC's W3C trace context so the container's own OTLP
        // spans (via `@lunora/container/otel`) stitch under the same trace.
        request.headers.set("traceparent", traceparent);
    }

    return request;
};

const sleep = async (ms: number): Promise<void> => {
    if (ms <= 0) {
        return;
    }

    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

/**
 * Thrown-error shapes the platform raises while an instance is still coming up:
 * "There is no Container instance…", "the container is not listening", a
 * rate-limited start, or a "try again later". Always safe to retry — the request
 * never reached the app.
 */
const COLD_START_ERROR_PATTERN = /no container instance|not listening|try again later|rate.?limit|provision/i;

/** Body sentinels `@cloudflare/containers` returns (as 503/500) for the same cold-start transients. */
const COLD_START_NO_INSTANCE_BODY = "no Container instance available";
const COLD_START_START_FAILURE_BODY = "Failed to start container:";

/**
 * Bytes of a 500/503 body we scan for a cold-start sentinel. The platform's
 * provisioning errors are short, fixed strings that lead the body, so a small
 * prefix is enough — and capping the read keeps a large or streaming *app* error
 * (which we never match and pass straight through) from stalling the retry path
 * or buffering megabytes just to decide not to retry.
 */
const COLD_START_SENTINEL_SCAN_BYTES = 1024;

/**
 * Read at most {@link COLD_START_SENTINEL_SCAN_BYTES} of a response body, then
 * cancel the reader so the rest is never pulled. Reads off the clone's stream so
 * the caller's `response` stays untouched.
 */
const readBodyPrefix = async (response: Response): Promise<string> => {
    const stream = response.clone().body;

    if (stream === null) {
        return "";
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
        while (text.length < COLD_START_SENTINEL_SCAN_BYTES) {
            // eslint-disable-next-line no-await-in-loop -- sequentially accumulate a bounded prefix, then stop.
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            text += decoder.decode(value, { stream: true });
        }
    } finally {
        await reader.cancel();
    }

    return text;
};

/** True when a thrown error is one of the platform's cold-start/provisioning transients. */
const isColdStartError = (error: unknown): boolean => error instanceof Error && COLD_START_ERROR_PATTERN.test(error.message);

/**
 * True when a *returned* response is a cold-start transient the base class
 * surfaced instead of throwing: a `429` (rate-limited start) or a `503`/`500`
 * whose body carries the no-instance / start-failure sentinel. Only a bounded
 * prefix is read off a clone, so the caller still gets an untouched response and
 * a large/streaming app error never has to be drained. A plain app `5xx` (no
 * sentinel) is left alone — this is not a blanket 5xx retry.
 */
const isColdStartTransient = async (response: Response): Promise<boolean> => {
    if (response.status === 429) {
        return true;
    }

    if (response.status !== 500 && response.status !== 503) {
        return false;
    }

    try {
        const body = await readBodyPrefix(response);

        return body.includes(COLD_START_NO_INSTANCE_BODY) || body.startsWith(COLD_START_START_FAILURE_BODY);
    } catch {
        // An unreadable/streaming body can't carry the sentinel we match — treat
        // it as a real (non-transient) response rather than retrying blindly.
        return false;
    }
};

/**
 * Wrap a per-attempt `send` with the cold-start retry: rebuild the request each
 * attempt and, on a provisioning transient (thrown {@link isColdStartError} or a
 * {@link isColdStartTransient} response), back off and try the *same* instance
 * again. A retry must re-issue the request, so it only kicks in for a replayable
 * path/URL-string input — a pre-built `Request` (possibly a one-shot stream
 * body) is sent exactly once. `.port()` re-binds the same `send`, so multi-port
 * routing composes with the retry uniformly.
 */
const coldStartRetryingHandle = (
    send: (request: Request) => Promise<Response>,
    options: InstanceRetryOptions = {},
    port?: number,
    traceparent?: string,
): ContainerHandle => {
    const attempts = Math.max(1, options.attempts ?? DEFAULT_COLD_START_ATTEMPTS);
    const baseBackoff = options.backoffMs ?? DEFAULT_COLD_START_BACKOFF_MS;
    const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    return {
        fetch: async (input, init) => {
            // Only a string input can be re-issued safely; a pre-built Request
            // may carry a body that can be consumed only once.
            const totalAttempts = typeof input === "string" ? attempts : 1;
            let lastError: unknown;

            for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
                const isLastAttempt = attempt === totalAttempts - 1;

                if (attempt > 0) {
                    // eslint-disable-next-line no-await-in-loop -- sequential retry with backoff between attempts
                    await sleep(Math.min(baseBackoff * 2 ** (attempt - 1), maxBackoff));
                }

                try {
                    // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential
                    const response = await send(toRequest(input, init, port, traceparent));

                    // eslint-disable-next-line no-await-in-loop -- the cold-start check peeks the body
                    if (isLastAttempt || !(await isColdStartTransient(response))) {
                        return response;
                    }
                } catch (error: unknown) {
                    lastError = error;

                    // A non-transient throw (or the final attempt) propagates immediately.
                    if (isLastAttempt || !isColdStartError(error)) {
                        throw error;
                    }
                }
            }

            // Unreachable in practice (every iteration returns or throws), but
            // keeps the control flow total for the type checker.
            throw lastError instanceof Error ? lastError : new Error("ctx.containers: cold-start retry exhausted");
        },
        port: (targetPort) => coldStartRetryingHandle(send, options, targetPort, traceparent),
    };
};

const handleFor = (namespace: ContainerNamespaceLike, instanceName: string, options?: InstanceRetryOptions, traceparent?: string): ContainerHandle =>
    coldStartRetryingHandle(async (request) => namespace.get(namespace.idFromName(instanceName)).fetch(request), options, undefined, traceparent);

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

/**
 * The runtime egress controls for a named instance, each mapping a `handle.egress.*`
 * method to its `@cloudflare/containers` `Container` RPC. Re-derives the stub per
 * call (DO stubs are cheap and shouldn't be cached across the await boundary).
 */
const egressControlsFor = (stub: () => ContainerStubLike, binding: string): ContainerEgressControls => {
    return {
        allow: async (hostname) => lifecycleCall(stub(), "allowHost", binding, hostname),
        deny: async (hostname) => lifecycleCall(stub(), "denyHost", binding, hostname),
        removeAllowed: async (hostname) => lifecycleCall(stub(), "removeAllowedHost", binding, hostname),
        removeDenied: async (hostname) => lifecycleCall(stub(), "removeDeniedHost", binding, hostname),
        setAllowed: async (hosts) => lifecycleCall(stub(), "setAllowedHosts", binding, [...hosts]),
        setDenied: async (hosts) => lifecycleCall(stub(), "setDeniedHosts", binding, [...hosts]),
    };
};

/** A named-instance handle: `fetch`/`.port()` plus the container DO's lifecycle + egress RPCs. */
const instanceHandleFor = (
    namespace: ContainerNamespaceLike,
    spec: ContainerBindingSpec,
    instanceName: string,
    options?: InstanceRetryOptions,
    traceparent?: string,
): ContainerInstanceHandle => {
    const stub = (): ContainerStubLike => namespace.get(namespace.idFromName(instanceName));

    return {
        ...coldStartRetryingHandle(async (request) => stub().fetch(request), options, undefined, traceparent),
        destroy: async () => lifecycleCall(stub(), "destroy", spec.binding),
        egress: egressControlsFor(stub, spec.binding),
        getState: async () => lifecycleCall(stub(), "getState", spec.binding),
        renewActivityTimeout: async () => lifecycleCall(stub(), "renewActivityTimeout", spec.binding),
        start: async (startOptions) => lifecycleCall(stub(), "start", spec.binding, startOptions),
        stop: async (signal) => lifecycleCall(stub(), "stop", spec.binding, signal),
    };
};

/** A random pool-instance name in `[0, size)`. */
const randomPoolName = (size: number): string =>
    // eslint-disable-next-line sonarjs/pseudo-random -- load-balancing pick across interchangeable instances, not a security decision
    `pool-${String(Math.floor(Math.random() * size))}`;

/** Default retry predicate: a server error (5xx) is worth another instance. */
const retryOnServerError = (response: Response): boolean => response.status >= 500;

/**
 * A pooled handle: each fetch picks a random instance, and on a thrown error or
 * a retryable response retries on a freshly-picked instance with exponential
 * backoff. Pure over the namespace, so it's testable with a fake. The final
 * attempt's outcome (response or thrown error) is returned/propagated as-is.
 */
const poolHandleFor = (
    namespace: ContainerNamespaceLike,
    spec: ContainerBindingSpec,
    options: PoolOptions = {},
    port?: number,
    traceparent?: string,
): ContainerHandle => {
    const size = options.size ?? spec.maxInstances ?? DEFAULT_POOL_SIZE;
    const attempts = Math.max(1, options.attempts ?? 3);
    const baseBackoff = options.backoffMs ?? 100;
    const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const shouldRetry = options.retryOn ?? retryOnServerError;

    return {
        fetch: async (input, init) => {
            // Only a string input can be re-issued safely; a pre-built Request
            // may carry a body that's consumed on the first send, so re-building
            // it on a retry throws "Body has already been used". Mirror
            // `coldStartRetryingHandle` and send such inputs exactly once.
            const totalAttempts = typeof input === "string" ? attempts : 1;
            let lastError: unknown;

            for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
                if (attempt > 0) {
                    // Clamp the doubling delay to the ceiling so a high `attempts`
                    // value can't produce an unboundedly long sleep.
                    // eslint-disable-next-line no-await-in-loop -- sequential retry with backoff between attempts
                    await sleep(Math.min(baseBackoff * 2 ** (attempt - 1), maxBackoff));
                }

                const request = toRequest(input, init, port, traceparent);

                try {
                    // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential
                    const response = await namespace.get(namespace.idFromName(randomPoolName(size))).fetch(request);

                    if (attempt === totalAttempts - 1 || !shouldRetry(response)) {
                        return response;
                    }
                } catch (error: unknown) {
                    lastError = error;
                }
            }

            // Exhausted attempts after a thrown error on the last try.
            throw lastError instanceof Error ? lastError : new Error(`ctx.containers.${spec.exportName}.pool(): all ${String(totalAttempts)} attempts failed`);
        },
        port: (targetPort) => poolHandleFor(namespace, spec, options, targetPort, traceparent),
    };
};

const accessorFor = (namespace: ContainerNamespaceLike, spec: ContainerBindingSpec, traceparent?: string): ContainerAccessor => {
    return {
        any: (count, options) => handleFor(namespace, randomPoolName(count ?? spec.maxInstances ?? DEFAULT_POOL_SIZE), options, traceparent),
        get: (name, options) => instanceHandleFor(namespace, spec, name, options, traceparent),
        pool: (options) => poolHandleFor(namespace, spec, options, undefined, traceparent),
    };
};

/** Accessor used when the binding is absent: every call throws a directed error. */
const missingBindingAccessor = (spec: ContainerBindingSpec): ContainerAccessor => {
    const fail = (): never => {
        throw new LunoraError(
            "INTERNAL",
            `ctx.containers.${spec.exportName}: no "${spec.binding}" Durable Object binding found. Run \`lunora dev\` (or \`lunora deploy\`) to reconcile wrangler.jsonc, and make sure the worker entry re-exports the generated container classes.`,
        );
    };

    return { any: fail, get: fail, pool: fail };
};

/**
 * Build the `ctx.containers` record from the Worker `env`. Called by the
 * generated ShardDO with the specs codegen derived from `lunora/containers.ts`.
 * A missing binding doesn't throw here — only when the handle is actually used —
 * so one unprovisioned container never breaks unrelated functions.
 *
 * `traceparent` (the inbound RPC's W3C trace context, forwarded by the runtime
 * and read off the request by the DO) is stamped onto every outbound container
 * `fetch`, so the container's own spans stitch under the Worker's trace.
 * @experimental
 */
const createContainerContext = (
    env: Record<string, unknown>,
    specs: ReadonlyArray<ContainerBindingSpec>,
    jurisdiction?: DurableObjectJurisdiction,
    traceparent?: string,
): Record<string, ContainerAccessor> => {
    const containers: Record<string, ContainerAccessor> = {};

    for (const spec of specs) {
        const binding = env[spec.binding] as ContainerNamespaceLike | undefined;

        containers[spec.exportName] =
            binding && typeof binding.idFromName === "function" && typeof binding.get === "function"
                ? accessorFor(applyJurisdiction(binding, jurisdiction), spec, traceparent)
                : missingBindingAccessor(spec);
    }

    return containers;
};

/**
 * A test handler: receives the request plus the targeted instance name.
 * @experimental
 */
type ContainerTestHandler = (request: Request, instance: { name: string }) => Promise<Response> | Response;

/**
 * A fake DO namespace backing the test double: every instance's `fetch` plays
 * the user's handler, and the lifecycle/egress RPCs are inert (resolve void / a
 * stub state). Built so the double reuses the *real* `instanceHandleFor` /
 * `handleFor` wiring — it can't drift from the production handle shape — while
 * staying Docker-free. `idFromName` is identity so the handler sees the
 * instance name unchanged.
 */
const testNamespaceFor = (handler: ContainerTestHandler): ContainerNamespaceLike => {
    const stubFor = (name: string): ContainerStubLike => {
        return {
            allowHost: () => Promise.resolve(),
            denyHost: () => Promise.resolve(),
            destroy: () => Promise.resolve(),
            fetch: (request) => Promise.resolve(handler(request, { name })),
            getState: () => Promise.resolve({ lastChange: 0 }),
            removeAllowedHost: () => Promise.resolve(),
            removeDeniedHost: () => Promise.resolve(),
            renewActivityTimeout: () => Promise.resolve(),
            setAllowedHosts: () => Promise.resolve(),
            setDeniedHosts: () => Promise.resolve(),
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
        };
    };

    return { get: (id) => stubFor(String(id)), idFromName: (name) => name };
};

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
 * @experimental
 */
const createContainerTestContext = (handlers: Record<string, ContainerTestHandler>): Record<string, ContainerAccessor> => {
    const containers: Record<string, ContainerAccessor> = {};

    for (const [exportName, handler] of Object.entries(handlers)) {
        const namespace = testNamespaceFor(handler);
        const spec: ContainerBindingSpec = { binding: containerBindingName(exportName), exportName };

        containers[exportName] = {
            // `.any()`/`.pool()` route to a fixed `pool-0` so the handler's
            // `instance.name` is deterministic under test; the double doesn't
            // simulate the random-pick or retry/backoff the real pool/cold-start
            // path does (`attempts: 1` keeps a handler's own 5xx from looping).
            any: () => handleFor(namespace, "pool-0", { attempts: 1 }),
            get: (name) => instanceHandleFor(namespace, spec, name, { attempts: 1 }),
            pool: () => handleFor(namespace, "pool-0", { attempts: 1 }),
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
    InstanceRetryOptions,
    PoolOptions,
};
export { createContainerContext, createContainerTestContext };

export { type DurableObjectJurisdiction } from "./jurisdiction";
