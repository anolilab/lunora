/**
 * The `ctx.containers` action surface: typed handles over the `CONTAINER_*`
 * Durable Object namespace bindings the config layer reconciles.
 *
 * Deliberately structural (no `@cloudflare/containers` import): a Durable
 * Object namespace stub is all that is needed to route a request to a
 * container-enabled DO, so this module stays Node-safe and the test double
 * below can satisfy the exact same shape without a workerd runtime.
 */

/** What a handle needs from a Durable Object stub. */
interface ContainerStubLike {
    fetch: (input: Request) => Promise<Response>;
}

/** What the client needs from a Durable Object namespace binding. */
interface ContainerNamespaceLike {
    get: (id: unknown) => ContainerStubLike;
    idFromName: (name: string) => unknown;
}

/** A handle on one container instance (one Durable Object). */
interface ContainerHandle {
    /**
     * Send an HTTP (or WebSocket-upgrade) request to the container. A path
     * string (`"/transcode"`) is resolved against a synthetic origin; a full
     * `Request`/URL passes through unchanged.
     */
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

/** The per-definition accessor exposed as `ctx.containers.&lt;exportName>`. */
interface ContainerAccessor {
    /**
     * A random instance from a fixed pool of `count` (defaults to the
     * definition's `maxInstances`, else 3 — mirroring `getRandom` from
     * `@cloudflare/containers`). For stateless, interchangeable workloads.
     */
    any: (count?: number) => ContainerHandle;
    /** The instance for `name` — one container per entity (user, room, job…). */
    get: (name: string) => ContainerHandle;
}

/** Wiring info for one definition, emitted by codegen into the generated DO. */
interface ContainerBindingSpec {
    /** Durable Object binding name, e.g. `CONTAINER_TRANSCODER`. */
    binding: string;
    /** The `cirrus/containers.ts` export name, e.g. `transcoder`. */
    exportName: string;
    /** Pool size default for `.any()`. */
    maxInstances?: number;
}

/**
 * Mirror of `getRandom`'s default pool size in `@cloudflare/containers`, used
 * when a definition declares no `maxInstances`.
 */
const DEFAULT_POOL_SIZE = 3;

const toRequest = (input: Request | string, init?: RequestInit): Request => {
    if (typeof input === "string" && input.startsWith("/")) {
        return new Request(`http://container${input}`, init);
    }

    return new Request(input, init);
};

const handleFor = (namespace: ContainerNamespaceLike, instanceName: string): ContainerHandle => {
    return {
        fetch: async (input, init) => namespace.get(namespace.idFromName(instanceName)).fetch(toRequest(input, init)),
    };
};

const accessorFor = (namespace: ContainerNamespaceLike, spec: ContainerBindingSpec): ContainerAccessor => {
    return {
        any: (count) => {
            const poolSize = count ?? spec.maxInstances ?? DEFAULT_POOL_SIZE;

            // eslint-disable-next-line sonarjs/pseudo-random -- load-balancing pick across interchangeable instances, not a security decision
            return handleFor(namespace, `pool-${String(Math.floor(Math.random() * poolSize))}`);
        },
        get: (name) => handleFor(namespace, name),
    };
};

/** Accessor used when the binding is absent: every call throws a directed error. */
const missingBindingAccessor = (spec: ContainerBindingSpec): ContainerAccessor => {
    const fail = (): never => {
        throw new Error(
            `ctx.containers.${spec.exportName}: no "${spec.binding}" Durable Object binding found. Run \`cirrus dev\` (or \`cirrus deploy\`) to reconcile wrangler.jsonc, and make sure the worker entry re-exports the generated container classes.`,
        );
    };

    return { any: fail, get: fail };
};

/**
 * Build the `ctx.containers` record from the Worker `env`. Called by the
 * generated ShardDO with the specs codegen derived from
 * `cirrus/containers.ts`. A missing binding doesn't throw here — only when the
 * handle is actually used — so one unprovisioned container never breaks
 * unrelated functions.
 */
const createContainerContext = (env: Record<string, unknown>, specs: ReadonlyArray<ContainerBindingSpec>): Record<string, ContainerAccessor> => {
    const containers: Record<string, ContainerAccessor> = {};

    for (const spec of specs) {
        const namespace = env[spec.binding] as ContainerNamespaceLike | undefined;

        containers[spec.exportName] =
            namespace && typeof namespace.idFromName === "function" && typeof namespace.get === "function"
                ? accessorFor(namespace, spec)
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
        const testHandleFor = (instanceName: string): ContainerHandle => {
            return {
                fetch: async (input, init) => handler(toRequest(input, init), { name: instanceName }),
            };
        };

        containers[exportName] = {
            any: () => testHandleFor("pool-0"),
            get: (name) => testHandleFor(name),
        };
    }

    return containers;
};

export type { ContainerAccessor, ContainerBindingSpec, ContainerHandle, ContainerNamespaceLike, ContainerTestHandler };
export { createContainerContext, createContainerTestContext };
