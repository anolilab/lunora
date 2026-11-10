import type { Context } from "react";
import { createContext } from "react";

/**
 * One registry per JavaScript realm, keyed by a global symbol rather than kept in this module.
 *
 * pnpm installs `@lunora/react` once per peer context, so an app can bundle two copies of this
 * package. Each copy would call `createContext` on its own, and the provider from one copy would
 * write a context the hooks of the other copy never read: `useLunora()` then throws "must be used
 * inside <LunoraProvider />" under a provider it is nested in. Looking the context up by name in a
 * shared registry makes every copy read the same `Context` object.
 */
const REGISTRY = Symbol.for("@lunora/react/contexts");

interface SharedContextEntry {
    context: Context<unknown>;
    /** The kind of the default value it was created with, so a reused name cannot hand back a context of another type. */
    kind: string;
}

const registryOf = (): Map<string, SharedContextEntry> => {
    const host = globalThis as unknown as Record<symbol, Map<string, SharedContextEntry> | undefined>;

    host[REGISTRY] ??= new Map<string, SharedContextEntry>();

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
