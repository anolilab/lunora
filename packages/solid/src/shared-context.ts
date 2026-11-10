import type { Context } from "solid-js";
import { createContext } from "solid-js";

interface RegisteredContext {
    context: Context<unknown>;
    /** The kind of the default value it was created with, so a reused name cannot hand back a context of another type. */
    kind: string;
}

/**
 * One registry per JavaScript realm, keyed by a global symbol rather than kept in this module. Two copies of this package
 * (pnpm installs one per peer variant) would otherwise each create their own context, and a provider from one copy would never
 * reach a hook from the other.
 */
const REGISTRY = Symbol.for("@lunora/solid/contexts");

const registryOf = (): Map<string, RegisteredContext> => {
    const host = globalThis as unknown as Record<symbol, Map<string, RegisteredContext> | undefined>;

    host[REGISTRY] ??= new Map<string, RegisteredContext>();

    return host[REGISTRY];
};

const kindOf = (value: unknown): string => (value === null ? "null" : typeof value);

/** The context registered under `name`, created with `defaultValue` the first time any copy of this package asks for it. */
const sharedContext = function <T>(name: string, defaultValue: T): Context<T> {
    const registry = registryOf();
    const kind = kindOf(defaultValue);
    const existing = registry.get(name);

    if (existing !== undefined) {
        if (existing.kind !== kind) {
            throw new Error(`Context "${name}" was registered with a ${existing.kind} default; a copy asked for a ${kind} default.`);
        }

        return existing.context as Context<T>;
    }

    const created = createContext(defaultValue);

    registry.set(name, { context: created as Context<unknown>, kind });

    return created;
};

export default sharedContext;
