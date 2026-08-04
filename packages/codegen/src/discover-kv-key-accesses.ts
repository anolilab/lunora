import type { Project } from "ts-morph";

import { discoverArgumentDerivedAccesses } from "./discover-argument-derived-accesses";
import type { KvKeyAccessIR } from "./ir";

/**
 * The `ctx.kv` methods whose first argument is a per-entry namespace key. `list`
 * is deliberately excluded — it takes an options object (a `prefix`), not a
 * single key, so it is not an entry-level IDOR sink. Confirmed against the `Kv`
 * facade in `@lunora/bindings/kv`.
 */
const KV_KEY_METHODS = new Set(["delete", "get", "getRaw", "getWithMetadata", "put"]);

/**
 * Discover `ctx.kv.<method>(key, …)` calls in `lunora/` whose key is derived from
 * the handler's `args` with no server-side scoping — the `kv_unscoped_user_key_idor`
 * lint input. Workers KV is a single flat namespace, so a key taken straight from
 * request input lets any caller read, overwrite, or delete another user's entry
 * (IDOR). A fixed literal key, or one prefixed with a server-trusted identity
 * (`` `${ctx.auth.userId}:…` `` — references `ctx`, so treated as scoped), is not
 * recorded; only an arg-derived, unscoped key (directly, or through one local
 * `const` hop) reaches here. `list` is excluded (it takes a prefix, not a key).
 */
const discoverKvKeyAccesses = (project: Project, lunoraDirectory: string): KvKeyAccessIR[] =>
    discoverArgumentDerivedAccesses(project, lunoraDirectory, {
        argIndex: 0,
        matchReceiver: (receiver) => receiver === "ctx.kv" || receiver.startsWith("ctx.kv."),
        methods: KV_KEY_METHODS,
    });

export default discoverKvKeyAccesses;
