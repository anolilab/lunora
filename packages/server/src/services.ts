/**
 * `ctx.services` — typed Cloudflare service bindings to sibling Workers the app
 * declares in `lunora.config.*` `services` (plan 457). A service binding is a
 * plain `Fetcher` (or an RPC stub for a `WorkerEntrypoint`) on `env`; this module
 * only types it and resolves it by name, so the app never needs Cloudflare's
 * worker types to call one.
 */

/** A fetch-style service: the Worker's `fetch` handler, called without leaving Cloudflare. */
interface ServiceFetcher {
    readonly fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * An RPC service: every method of the `WorkerEntrypoint` class becomes an async
 * call (an RPC result always arrives as a promise), alongside its `fetch`.
 */
type ServiceRpc<Entrypoint extends abstract new (...parameters: never[]) => unknown> = ServiceFetcher & {
    readonly [
        Key in keyof InstanceType<Entrypoint> as InstanceType<Entrypoint>[Key] extends (...parameters: never[]) => unknown ? Key : never
    ]: InstanceType<Entrypoint>[Key] extends (...parameters: infer Parameters) => infer Result
        ? (...parameters: Parameters) => Promise<Awaited<Result>>
        : never;
};

/** Wiring for one declared service, emitted by codegen: its `ctx.services` key, its `env` binding, and whether it is an RPC entrypoint. */
interface ServiceBindingSpec {
    readonly binding: string;
    readonly name: string;
    readonly rpc?: true;
}

/** A stand-in for an unbound service: any use throws, naming the binding to add. */
const unboundService = (spec: ServiceBindingSpec): unknown =>
    new Proxy(
        {},
        {
            get(_target, property): undefined {
                // `then` is probed by `await`, and symbols by inspection
                // (`console.log`, `util.inspect`); answering them keeps the stand-in
                // from throwing somewhere unrelated to the call that needs it.
                if (property === "then" || typeof property === "symbol") {
                    return undefined;
                }

                throw new Error(
                    `ctx.services.${spec.name}: the "${spec.binding}" service binding is not bound — run \`lunora dev\` (it reconciles wrangler services[]) or add it to wrangler.jsonc`,
                );
            },
        },
    );

/**
 * An RPC stub whose `fetch` is bound to it, like a fetch service's, so
 * `fetch: ctx.services.x.fetch` works for either kind. The stub is a workerd
 * host object (a wildcard property per entrypoint method), so it is wrapped,
 * not copied or extended, and every other property is read off the stub itself.
 */
const withBoundFetch = (stub: object): unknown => {
    let fetch: ServiceFetcher["fetch"] | undefined;

    return new Proxy(stub, {
        get(target, property): unknown {
            if (property === "fetch") {
                fetch ??= (target as ServiceFetcher).fetch.bind(target);

                return fetch;
            }

            return Reflect.get(target, property, target);
        },
    });
};

/**
 * Build `ctx.services` from the Worker `env` and the codegen-emitted specs. A
 * fetch service comes back as `{ fetch }` with `fetch` bound to the binding; an
 * RPC service as its stub, with `fetch` bound the same way. A
 * declared service whose binding is absent resolves to a stand-in that throws on
 * first use, so a missing binding names itself instead of failing as
 * `Cannot read properties of undefined`.
 */
const createServices = (env: Record<string, unknown>, specs: ReadonlyArray<ServiceBindingSpec>): Record<string, unknown> => {
    const services: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const spec of specs) {
        const binding = env[spec.binding];

        if ((typeof binding !== "object" && typeof binding !== "function") || binding === null) {
            services[spec.name] = unboundService(spec);
        } else if (spec.rpc === true) {
            // An RPC stub: its methods are called on it, so it is handed over
            // as is — apart from `fetch`, bound so it too can be passed detached.
            services[spec.name] = withBoundFetch(binding);
        } else {
            // A Fetcher's `fetch` needs its `this`; binding it lets callers pass
            // `fetch: ctx.services.x.fetch` to a client, as the docs show.
            const fetcher = binding as ServiceFetcher;

            services[spec.name] = { fetch: fetcher.fetch.bind(fetcher) } satisfies ServiceFetcher;
        }
    }

    return services;
};

export type { ServiceBindingSpec, ServiceFetcher, ServiceRpc };
export { createServices };
