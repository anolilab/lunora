/**
 * Node adapter: an in-process registry that both *resolves* shard keys and
 * hosts* the shards behind them, satisfying the provider-neutral
 * `@lunora/platform` `ShardDirectory` contract.
 *
 * # Why this replaced a stub
 *
 * The first version of this module resolved a shard key to a stub whose
 * `fetch` answered `new Response(name)` — the key echoed back. That was enough
 * for the TCK's two directory legs (the same key resolves to the same thing,
 * and a resolved stub is dispatchable), and enough for nothing else: no shard
 * existed behind the stub, so a resolved stub could not run a query. It made
 * `crossShardFanout` unimplementable, because `@lunora/runtime`'s query
 * coordinator fans out by calling exactly this `fetch`
 * (`callOneShard` → `resolveShard(namespace, shardKey).fetch(...)`).
 *
 * A directory that resolves but does not dispatch is the shape of a
 * conformance-passing host that cannot serve a request, which is precisely the
 * failure mode the capability matrix exists to catch.
 *
 * # What a shard is here
 *
 * One shard key ⇒ one {@link NodeShard}: its own `better-sqlite3` database, its
 * own `ShardHost` (single-writer gate, local SQL, transactions, durable
 * alarms), its own `ShardKvStore`, and its own socket registry. Shards are
 * created lazily on first resolution and cached, so resolving a key twice hands
 * back the same live shard rather than reopening its database.
 *
 * Cloudflare gets this from `DurableObjectNamespace`: `idFromName` is
 * deterministic placement and the runtime materializes the object. A Node
 * process has no placement to do — there is one process — so the whole job is
 * the `Map` below plus the per-shard composition.
 *
 * # Durability of the key set
 *
 * `listShardKeys` is what the query coordinator asks before fanning out, and a
 * key set that lived only in memory would be empty on every boot: after a
 * restart, a fan-out would silently query *no* shards and return an empty
 * result that looks like "no matching rows". So when shards are file-backed the
 * registry seeds its key set from the files already on disk — the same
 * re-arm-on-construction principle the alarm and scheduler hosts follow.
 *
 * `jurisdiction` is deliberately **absent**: a single process cannot restrict
 * placement, and the contract requires callers to fail closed when the method
 * is missing rather than be handed a directory that silently ignores the
 * request.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DirectShardDirectory, ShardHost, ShardKvStore, ShardStub, SocketHost } from "@lunora/platform";

import { createNodeShardKvStore } from "./node-kv-store";
import { createNodeShardHost } from "./node-shard-host";
import { createNodeSocketHost } from "./node-socket-host";

/** Extension used for a file-backed shard's database. */
const SHARD_FILE_SUFFIX = ".sqlite3";

/**
 * Encode a shard key into a filesystem-safe basename.
 *
 * Percent-encoding everything outside `[A-Za-z0-9._-]` keeps simple keys
 * readable in a directory listing (`tenant-42.sqlite3`) while staying
 * reversible and safe for keys carrying `/`, `:` or spaces — all legal in a
 * shard key, none safe in a path segment.
 */
const encodeShardKey = (key: string): string =>
    key.replaceAll(/[^\w.-]/gu, (character) => `%${character.codePointAt(0)?.toString(16).padStart(2, "0").toUpperCase() ?? ""}`);

/** Inverse of {@link encodeShardKey}. */
const decodeShardKey = (basename: string): string => decodeURIComponent(basename);

/** The contracts scoped to one shard key. */
export interface NodeShard {
    /** Durable key-value storage on this shard's database. */
    kv: ShardKvStore;
    /** Single-writer execution, local SQL, transactions, durable alarms. */
    shard: ShardHost;
    /** The key this shard serves. */
    shardKey: string;
    /** This shard's socket registry, with SQLite-persisted attachments. */
    sockets: SocketHost;
}

/** Options for {@link createNodeShardRegistry}. */
export interface NodeShardRegistryOptions {
    /**
     * Directory to hold one SQLite file per shard. Omit for in-memory shards,
     * which is right for tests and wrong for anything that must survive a
     * restart — an in-memory registry also has no files to seed its key set
     * from, so its fan-out set is empty until each shard is touched again.
     */
    directory?: string;

    /** Called when a shard's durable alarm comes due. */
    onAlarm?: (shard: NodeShard) => Promise<void> | void;

    /**
     * The app's per-shard request handler — the Node equivalent of
     * `ShardDO.fetch`. This is what a resolved stub dispatches to, and what the
     * query coordinator reaches on every fan-out leg.
     *
     * Omitted, a resolved stub answers with the shard key. That is not a
     * placeholder for convenience: it is the exact behaviour the TCK's
     * directory legs assert (same key ⇒ same body, and a stub is dispatchable),
     * so the conformance run exercises this registry rather than a second
     * implementation kept alive just for tests.
     */
    onFetch?: (request: Request, shard: NodeShard) => Promise<Response> | Response;
}

/** An in-process shard registry: placement, hosting, and the fan-out key set. */
export interface NodeShardRegistry {
    /** Dispose every live shard. Safe to call more than once. */
    close: () => void;
    /** The `ShardDirectory` to hand the runtime. */
    directory: DirectShardDirectory;

    /**
     * Every shard key this registry knows about — the set `@lunora/runtime`'s
     * query coordinator fans out over.
     *
     * The `table` argument is accepted and ignored, which is a real
     * approximation worth stating: Cloudflare's dynamic registry tracks which
     * shard keys hold rows for which table, while this one knows only that a
     * shard exists. Answering with every shard is a *superset*, so results stay
     * correct — a shard holding no rows for the table contributes none — at the
     * cost of visiting shards that had nothing to say.
     */
    listShardKeys: (table?: string) => ReadonlyArray<string>;
    /** Materialize (or reuse) the shard serving `key`. */
    shardFor: (key: string) => NodeShard;
}

/** Build the in-process shard registry. */
export const createNodeShardRegistry = (options: NodeShardRegistryOptions = {}): NodeShardRegistry => {
    const live = new Map<string, { dispose: () => void; shard: NodeShard }>();

    /**
     * Keys known to exist, whether or not their shard is currently live.
     *
     * Separate from `live` because the two answer different questions: `live`
     * is "what is open right now", this is "what exists" — and a fan-out must
     * be driven by the second, or a shard that has not been touched since boot
     * drops out of the result set.
     */
    const known = new Set<string>();

    if (options.directory !== undefined) {
        mkdirSync(options.directory, { recursive: true });

        for (const entry of readdirSync(options.directory)) {
            if (entry.endsWith(SHARD_FILE_SUFFIX)) {
                known.add(decodeShardKey(entry.slice(0, -SHARD_FILE_SUFFIX.length)));
            }
        }
    }

    const shardFor = (key: string): NodeShard => {
        const existing = live.get(key);

        if (existing !== undefined) {
            return existing.shard;
        }

        const path = options.directory === undefined ? undefined : join(options.directory, `${encodeShardKey(key)}${SHARD_FILE_SUFFIX}`);

        // Built in two steps because the alarm hook needs the shard it belongs
        // to, and the shard does not exist until the host that carries the hook
        // is constructed. The closure reads `shard` lazily, by which time the
        // assignment below has run.
        let shard: NodeShard;

        const {
            database,
            dispose: disposeHost,
            host,
        } = createNodeShardHost({
            onAlarm: () => options.onAlarm?.(shard),
            path,
            shardKey: key,
        });

        shard = {
            kv: createNodeShardKvStore(database),
            shard: host,
            shardKey: key,
            sockets: createNodeSocketHost(database).socket,
        };

        live.set(key, { dispose: disposeHost, shard });
        known.add(key);

        return shard;
    };

    const stubFor = (key: string): ShardStub => {
        return {
            fetch: async (request) => {
                const shard = shardFor(key);

                if (options.onFetch === undefined) {
                    return new Response(key);
                }

                return options.onFetch(request, shard);
            },
        };
    };

    return {
        close: () => {
            for (const entry of live.values()) {
                entry.dispose();
            }

            live.clear();
        },
        directory: {
            get: (id) => stubFor(String(id)),
            getByName: (name) => stubFor(name),
            // The key itself. There is nothing to hide behind an opaque id — no
            // cross-node routing, no jurisdiction — and the contract types `id`
            // as `unknown`, so this is a legitimate if degenerate choice.
            idForName: (name) => name,
        },
        listShardKeys: () => [...known],
        shardFor,
    };
};
