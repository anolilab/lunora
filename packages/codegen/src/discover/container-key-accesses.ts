import type { Project } from "ts-morph";

import { discoverArgumentDerivedAccesses } from "./discover-argument-derived-accesses";
import type { ContainerKeyAccessIR } from "./ir";

/** The `ctx.containers.` accessor prefix a single-container instance sink must start with. */
const CONTAINER_ACCESSOR_PREFIX = "ctx.containers.";

/**
 * `true` when `receiver` is a *single* container accessor
 * (`ctx.containers.<exportName>`, with nothing past the export segment) — the
 * `.get(name)` receiver shape. `.any()`/`.pool()` take no key and carry a
 * different method name, so they never reach this predicate.
 */
const isContainerInstanceReceiver = (receiver: string): boolean => {
    if (!receiver.startsWith(CONTAINER_ACCESSOR_PREFIX)) {
        return false;
    }

    const remainder = receiver.slice(CONTAINER_ACCESSOR_PREFIX.length);

    return remainder.length > 0 && !remainder.includes(".");
};

/**
 * Discover `ctx.containers.<exportName>.get(name, …)` calls in `lunora/` whose
 * instance key is derived from the handler's `args` with no server-side
 * scoping — the `container_instance_key_from_user_input` lint input. Each
 * container definition's `.get(name)` accessor routes to one instance per
 * `name`, so a key taken straight from request input lets any caller reach any
 * other tenant's container (a cross-tenant IDOR). A fixed literal key, or one
 * derived from a server-trusted identity (`` `${ctx.auth.userId}` `` —
 * references `ctx`, so treated as scoped), is not recorded; only an
 * arg-derived, unscoped key (directly, or through one local `const` hop)
 * reaches here. `.any()`/`.pool()` take no key and are not sinks.
 */
const discoverContainerKeyAccesses = (project: Project, lunoraDirectory: string): ContainerKeyAccessIR[] =>
    discoverArgumentDerivedAccesses(project, lunoraDirectory, {
        argIndex: 0,
        matchReceiver: isContainerInstanceReceiver,
        methods: new Set(["get"]),
    });

export default discoverContainerKeyAccesses;
