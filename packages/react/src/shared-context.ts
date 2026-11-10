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

const registryOf = (): Map<string, unknown> => {
    const host = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;

    host[REGISTRY] ??= new Map<string, unknown>();

    return host[REGISTRY];
};

/** The context registered under `name`, created with `defaultValue` the first time any copy of this package asks for it. */
const sharedContext = <T>(name: string, defaultValue: T): Context<T> => {
    const registry = registryOf();
    const existing = registry.get(name);

    if (existing !== undefined) {
        return existing as Context<T>;
    }

    const created = createContext(defaultValue);

    registry.set(name, created);

    return created;
};

export default sharedContext;
