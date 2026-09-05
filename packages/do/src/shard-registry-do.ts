/**
 * Durable Object that owns the live set of shard keys per sharded table.
 *
 * The query coordinator (`@lunora/runtime`) fans out cross-shard reads to
 * every live shard. With the static registry, the app supplies the shard
 * key list at boot — which is fine for fixed-cardinality deployments
 * (a known set of tenants) and unworkable for dynamic ones (one shard per
 * user-created channel, organisation, project, …).
 *
 * `ShardRegistryDO` is the persistent source of truth. A worker:
 *
 * - calls `POST /register {table, shardKey}` when a sharded table first
 * sees a write on a new key (typically from `ctx.db.<table>.insert` via
 * the worker's onWrite hook, fired through `ctx.waitUntil` so the
 * user-facing write doesn't pay the registry round-trip);
 * - calls `POST /unregister {table, shardKey}` when a shard is decommissioned;
 * - calls `GET /list?table=X` to materialise the fan-out target list. The
 * client (`createDynamicShardRegistry` in `@lunora/runtime`) caches the
 * answer with a small TTL so a wide fan-out doesn't pay a registry
 * round-trip on every call.
 *
 * Single-instance contract: deploy one DO instance per environment, by
 * convention named {@link SHARD_REGISTRY_DO_NAME}. The DO is small (just a
 * `Map<table, Set<shardKey>>`) and writes are infrequent (only on first-seen
 * shardKey per table), so a single instance is sufficient up to tens of
 * thousands of distinct shard keys.
 *
 * That last claim is only true because each shard key is its OWN storage key.
 * The whole `table → [keys]` map used to be persisted as a single JSON value,
 * which put a hard ceiling on the registry at the per-value storage limit —
 * 2 MB on a SQLite-backed Durable Object, 128 KiB on a KV-backed one — around
 * 50k UUID-shaped keys, or 3k on the older backend. That is INSIDE the workload
 * this DO exists for ("one shard per user-created channel/organisation/project"),
 * and the failure was silent: the `put` threw inside `blockConcurrencyWhile`
 * after the in-memory set had already been mutated, so the registry answered
 * `/list` with a key it had not persisted and every later register threw too.
 * One key per `(table, shardKey)` has no such ceiling, writes a single small
 * value per registration instead of rewriting the whole snapshot, and lets the
 * in-memory mutation wait until the write has actually landed.
 *
 * Wire shape: HTTP only, never RPC.
 *
 * POST /register   body: { table, shardKey }
 * POST /unregister body: { table, shardKey }
 * GET  /list?table=...
 * GET  /snapshot                (debug: returns the full table → [keys] map)
 *
 * Responses are JSON; the client shapes them. Keep the surface narrow.
 */
import { jsonResponse } from "../../../shared/json-response";

/** Conventional DO instance name, passed to `idFromName` to address the single registry instance. */
const SHARD_REGISTRY_DO_NAME: string = "__lunora_shard_registry__";

/**
 * Prefix every persisted registration carries, so `list` can read the registry
 * back without picking up anything else stored on this DO.
 */
const ENTRY_PREFIX = "s:";

/**
 * Separator between the table and the shard key in a storage key. NUL rather
 * than a printable character because a shard key is caller-supplied and must
 * not be able to forge a different table's entry; the reverse mapping does not
 * depend on it either (the value carries both parts).
 */
const KEY_SEPARATOR = "\u0000";

/**
 * Storage-key ceiling. The lower of the two documented Durable Object limits —
 * KV-backed caps a key at 2 KiB, SQLite-backed caps key and value combined at
 * 2 MB — so a registration accepted here fits on either backend.
 */
const MAX_STORAGE_KEY_BYTES = 2048;

/** One persisted registration. The pair is stored whole so the load path never parses a key. */
interface PersistedEntry {
    shardKey: string;
    table: string;
}

/** The storage key one `(table, shardKey)` registration is persisted under. */
const entryKey = (table: string, shardKey: string): string => `${ENTRY_PREFIX}${table}${KEY_SEPARATOR}${shardKey}`;

/**
 * Subset of `DurableObjectState` we touch. Structural so unit tests can
 * pass a plain object without pulling in the workers runtime.
 */
interface ShardRegistryDOState {
    /**
     * Concurrency-blocking initializer — `state.blockConcurrencyWhile(fn)`
     * delays the next fetch dispatch until `fn` resolves. We use it to load
     * the persisted entries exactly once at construction and to serialize
     * the read-modify-write spans in `register` / `unregister` so two
     * concurrent callers can't race the in-memory map.
     */
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>;
    storage: {
        delete: (key: string) => Promise<boolean>;
        list: <T = unknown>(options: { prefix: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
    };
}

/**
 * Parse + validate the `{table, shardKey}` body shared by register/unregister.
 * Returns either the validated value or a ready-to-return error response.
 */
const readTableShardBody = async (
    request: Request,
): Promise<{ kind: "error"; response: Response } | { kind: "ok"; value: { shardKey: string; table: string } }> => {
    let body: { shardKey?: unknown; table?: unknown };

    try {
        body = await request.json();
    } catch {
        return { kind: "error", response: jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid JSON body" } }, 400) };
    }

    const table = typeof body.table === "string" ? body.table.trim() : "";
    const shardKey = typeof body.shardKey === "string" ? body.shardKey.trim() : "";

    if (!table || !shardKey) {
        return {
            kind: "error",
            response: jsonResponse({ error: { code: "BAD_REQUEST", message: "table and shardKey required" } }, 400),
        };
    }

    // Refused here rather than at the `put`, which is the only other place it
    // would surface — as a storage exception inside `blockConcurrencyWhile`,
    // after the caller had already been told the registration succeeded.
    if (new TextEncoder().encode(entryKey(table, shardKey)).length > MAX_STORAGE_KEY_BYTES) {
        return {
            kind: "error",
            response: jsonResponse(
                { error: { code: "BAD_REQUEST", message: `table and shardKey exceed the ${String(MAX_STORAGE_KEY_BYTES)}-byte storage key limit` } },
                400,
            ),
        };
    }

    return { kind: "ok", value: { shardKey, table } };
};

/**
 * Concrete (not abstract) DO class. Apps register this binding in their
 * `wrangler.jsonc` as `SHARD_REGISTRY` (or any name) — no subclassing
 * required. The runtime's `createDynamicShardRegistry` takes the namespace
 * binding and the conventional instance name and produces a `ShardRegistry`.
 */
class ShardRegistryDO {
    protected env: unknown;

    protected state: ShardRegistryDOState;

    /**
     * In-memory snapshot, rebuilt from the persisted entries on the first
     * fetch. Every mutation persists its own `(table, shardKey)` key BEFORE
     * touching this map, so the map never claims a registration storage
     * refused. It is the source of truth for reads, so `/list` never pays a
     * storage round-trip.
     */
    private readonly tables = new Map<string, Set<string>>();

    /**
     * Lazy-loaded — populated on the first `fetch` via
     * `blockConcurrencyWhile`. We can't load in the constructor (eslint:
     * `sonarjs/no-async-constructor`) and don't need to: until the first
     * fetch arrives the in-memory map is unread anyway.
     */
    private loaded: boolean = false;

    public constructor(state: ShardRegistryDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        await this.ensureLoaded();

        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/register") {
            return this.handleRegister(request);
        }

        if (request.method === "POST" && url.pathname === "/unregister") {
            return this.handleUnregister(request);
        }

        if (request.method === "GET" && url.pathname === "/list") {
            return this.handleList(url);
        }

        if (request.method === "GET" && url.pathname === "/snapshot") {
            return this.handleSnapshot();
        }

        return jsonResponse({ error: { code: "NOT_FOUND", message: `unknown shard-registry route ${request.method} ${url.pathname}` } }, 404);
    }

    /**
     * Load the persisted entries exactly once. `blockConcurrencyWhile`
     * suspends concurrent fetch dispatches on this DO until the load
     * finishes, so the `loaded` flag doesn't need an additional mutex.
     *
     * One `list` over the entry prefix, not one `get` per key: the whole
     * registry is a page of small rows, and `blockConcurrencyWhile` RESETS the
     * Durable Object if its callback runs past 30 seconds, which a
     * key-at-a-time load would eventually do.
     */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        await this.state.blockConcurrencyWhile(async () => {
            if (this.loaded) {
                return;
            }

            const stored = await this.state.storage.list<PersistedEntry>({ prefix: ENTRY_PREFIX });

            for (const entry of stored.values()) {
                let set = this.tables.get(entry.table);

                if (!set) {
                    set = new Set();
                    this.tables.set(entry.table, set);
                }

                set.add(entry.shardKey);
            }

            this.loaded = true;
        });
    }

    private handleList(url: URL): Response {
        const table = url.searchParams.get("table");

        if (!table) {
            return jsonResponse({ error: { code: "BAD_REQUEST", message: "missing required query parameter: table" } }, 400);
        }

        return jsonResponse({ shardKeys: [...(this.tables.get(table) ?? [])] }, 200);
    }

    private async handleRegister(request: Request): Promise<Response> {
        const parsed = await readTableShardBody(request);

        if (parsed.kind === "error") {
            return parsed.response;
        }

        const { shardKey, table } = parsed.value;

        // Wrap the read-modify-write in `blockConcurrencyWhile` so a concurrent
        // `register`/`unregister` on the same key can't interleave between the
        // membership check and the write. `ensureLoaded` runs outside this gate;
        // it has its own at the top of `fetch`.
        return this.state.blockConcurrencyWhile(async () => {
            let set = this.tables.get(table);

            if (set?.has(shardKey)) {
                return jsonResponse({ changed: false, ok: true }, 200);
            }

            // Persist FIRST. A `put` that throws must leave the in-memory map
            // untouched and the error visible to the caller — the reverse order
            // reported a shard key that was never durable, so `/list` served it
            // until the next eviction and then silently stopped.
            await this.state.storage.put(entryKey(table, shardKey), { shardKey, table } satisfies PersistedEntry);

            if (!set) {
                set = new Set();
                this.tables.set(table, set);
            }

            set.add(shardKey);

            return jsonResponse({ changed: true, ok: true }, 200);
        });
    }

    private handleSnapshot(): Response {
        return jsonResponse({ tables: this.serializeTables() }, 200);
    }

    private async handleUnregister(request: Request): Promise<Response> {
        const parsed = await readTableShardBody(request);

        if (parsed.kind === "error") {
            return parsed.response;
        }

        const { shardKey, table } = parsed.value;

        // Same race-on-mutate concern as `handleRegister` — wrap the
        // read-modify-write so two concurrent unregisters don't both see
        // the same set and overwrite each other's persist.
        return this.state.blockConcurrencyWhile(async () => {
            const set = this.tables.get(table);

            if (!set?.has(shardKey)) {
                return jsonResponse({ changed: false, ok: true }, 200);
            }

            // Persisted first, for the same reason `handleRegister` does it in
            // that order: a `delete` that throws must not leave the map claiming
            // the shard key is gone while storage still holds it.
            await this.state.storage.delete(entryKey(table, shardKey));

            set.delete(shardKey);

            if (set.size === 0) {
                this.tables.delete(table);
            }

            return jsonResponse({ changed: true, ok: true }, 200);
        });
    }

    /** The in-memory map as a JSON-safe `table → [keys]` object, for `/snapshot`. */
    private serializeTables(): Record<string, string[]> {
        return Object.fromEntries([...this.tables].map(([table, set]) => [table, [...set]]));
    }
}

export { SHARD_REGISTRY_DO_NAME, ShardRegistryDO };
