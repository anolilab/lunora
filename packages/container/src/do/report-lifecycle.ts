/**
 * Best-effort forwarder: push a container lifecycle envelope into the root
 * ShardDO's in-memory `LogBuffer` so it surfaces in the Studio Logs panel.
 *
 * The Container DO is a separate Durable Object from the ShardDO, but bindings
 * are worker-wide, so the ShardDO namespace (`env.SHARD`) is reachable from the
 * Container DO's `env`. We address the ROOT shard (`__root__`) — the same
 * default shard request dispatch uses — and POST the reserved
 * `__lunora_admin__:recordContainerEvent` admin RPC to its `/rpc` endpoint with
 * the admin bearer, mirroring how the worker fire-and-forgets `recordAuthEvent`
 * (`@lunora/runtime`'s `recordAuthAttempt`).
 *
 * Best-effort end to end: it resolves the admin token from
 * `env.LUNORA_ADMIN_TOKEN`, skips silently when no token (or no SHARD binding)
 * is configured, and swallows EVERY error — the `console` path printed by
 * `emitContainerLifecycle` remains the source of truth, so a failed push must
 * never break a lifecycle hook.
 */
import type { ContainerLifecycleEvent } from "../lifecycle-event";

/** Reserved admin op the root ShardDO serves to append a container event to its log buffer. */
const RECORD_CONTAINER_EVENT_OP = "__lunora_admin__:recordContainerEvent";

/** The root shard name — the default, unnamed shard (mirrors `@lunora/do`'s `ROOT_SHARD_NAME`). */
const ROOT_SHARD_NAME = "__root__";

/** A stub addressable by `.fetch`, returned by the ShardDO namespace. */
interface ShardStubLike {
    fetch: (request: Request) => Promise<Response>;
}

/**
 * Structural projection of the bits of the ShardDO `DurableObjectNamespace` we
 * need — `getByName` when available (the friendlier API), else `idFromName` +
 * `get`. Mirrors `@lunora/runtime`'s `ShardNamespaceLike` so a test double can
 * stand in without `@cloudflare/workers-types`.
 */
interface ShardNamespaceLike {
    get: (id: unknown) => ShardStubLike;
    getByName?: (name: string) => ShardStubLike;
    idFromName: (name: string) => unknown;
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ShardNamespaceLike;
}

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when none is configured. Fail-closed: throws when a jurisdiction is
 * requested but the binding can't honor it — the caller (a best-effort lifecycle
 * report) swallows the throw, so the event is dropped rather than written to the
 * un-pinned, out-of-region root shard.
 */
const applyJurisdiction = (namespace: ShardNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ShardNamespaceLike => {
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

/** Whether `value` looks like a usable ShardDO namespace binding. */
const isShardNamespace = (value: unknown): value is ShardNamespaceLike => {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const candidate = value as Partial<ShardNamespaceLike>;

    return typeof candidate.get === "function" && typeof candidate.idFromName === "function";
};

/** Resolve the root-shard stub, preferring `getByName` when present. Pins to `jurisdiction` when set. */
const resolveRootShard = (namespace: ShardNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ShardStubLike => {
    const pinned = applyJurisdiction(namespace, jurisdiction);

    if (typeof pinned.getByName === "function") {
        return pinned.getByName(ROOT_SHARD_NAME);
    }

    return pinned.get(pinned.idFromName(ROOT_SHARD_NAME));
};

/**
 * Forward one lifecycle envelope to the root ShardDO's log buffer, best-effort.
 *
 * `env` is the Container DO's worker `env`: we read the `SHARD` namespace and
 * the `LUNORA_ADMIN_TOKEN` from it. Returns a promise that NEVER rejects — every
 * failure path (missing binding, missing token, fetch error) resolves to
 * `undefined` — so the caller can `void` it from a lifecycle hook safely.
 */
const reportContainerLifecycle = async (env: unknown, envelope: ContainerLifecycleEvent, jurisdiction?: DurableObjectJurisdiction): Promise<void> => {
    try {
        const envRecord = (env ?? {}) as Record<string, unknown>;
        const namespace = envRecord["SHARD"];

        if (!isShardNamespace(namespace)) {
            return;
        }

        const adminBearer = typeof envRecord["LUNORA_ADMIN_TOKEN"] === "string" ? envRecord["LUNORA_ADMIN_TOKEN"] : undefined;

        // No admin token ⇒ the root shard's admin gate would reject the write;
        // skip silently so the buffer push is simply absent (the terminal still
        // has the event).
        if (!adminBearer || adminBearer.length === 0) {
            return;
        }

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { event: envelope }, functionPath: RECORD_CONTAINER_EVENT_OP }),
            headers: { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" },
            method: "POST",
        });

        await resolveRootShard(namespace, jurisdiction).fetch(request);
    } catch {
        // Best-effort: the console path (emitContainerLifecycle) is the source of
        // truth. A push failure must never break a container lifecycle hook.
    }
};

export type { DurableObjectJurisdiction, ShardNamespaceLike, ShardStubLike };
export { RECORD_CONTAINER_EVENT_OP, reportContainerLifecycle, ROOT_SHARD_NAME };
