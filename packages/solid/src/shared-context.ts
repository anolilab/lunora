import type { Context } from "solid-js";
import { createContext } from "solid-js";

interface SharedContextEntry {
    context: Context<unknown>;
    /** The kind of the default value it was created with, so a reused name cannot hand back a context of another type. */
    kind: string;
}

type ContextFactory = <T>(defaultValue: T) => Context<T>;

/**
 * One registry per JavaScript realm, keyed by a global symbol rather than kept in this module. Two copies of this package
 * (pnpm installs one per peer variant) would otherwise each create their own context, and a provider from one copy would never
 * reach a hook from the other.
 *
 * Contexts are partitioned by the Solid runtime that created them: each registry is keyed by that runtime's `createContext`. Solid 1
 * and Solid 2 can share a realm, and a context from one runtime is useless to the other, so names are shared only within a runtime.
 */
const REGISTRY = Symbol.for("@lunora/solid/contexts");

const runtimesOf = (): WeakMap<ContextFactory, Map<string, SharedContextEntry>> => {
    const host = globalThis as unknown as Record<symbol, WeakMap<ContextFactory, Map<string, SharedContextEntry>> | undefined>;

    host[REGISTRY] ??= new WeakMap<ContextFactory, Map<string, SharedContextEntry>>();

    return host[REGISTRY];
};

const kindOf = (value: unknown): string => (value === null ? "null" : typeof value);

/**
 * The context registered under `name` for the runtime whose `create` is given, created with `defaultValue` the first time any copy
 * of this package on that runtime asks for it.
 */
const sharedContextFor = function <T>(create: ContextFactory, name: string, defaultValue: T): Context<T> {
    const runtimes = runtimesOf();
    let registry = runtimes.get(create);

    if (!registry) {
        registry = new Map<string, SharedContextEntry>();
        runtimes.set(create, registry);
    }

    const kind = kindOf(defaultValue);
    const existing = registry.get(name);

    if (existing !== undefined) {
        if (existing.kind !== kind) {
            throw new Error(`Context "${name}" was registered with a ${existing.kind} default; a copy asked for a ${kind} default.`);
        }

        return existing.context as Context<T>;
    }

    const created = create(defaultValue);

    registry.set(name, { context: created as Context<unknown>, kind });

    return created;
};

/** The context registered under `name` on the Solid runtime this copy imports. */
const sharedContext = function <T>(name: string, defaultValue: T): Context<T> {
    return sharedContextFor(createContext, name, defaultValue);
};

export { sharedContextFor };
export default sharedContext;
