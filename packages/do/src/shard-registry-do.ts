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

/** Single key under which the full `table → [keys]` snapshot is persisted. */
const STORAGE_KEY = "__tables__";

/** Persistence shape — a plain object so DO storage can serialize it as JSON. */
type PersistedTables = Record<string, string[]>;

/**
 * Subset of `DurableObjectState` we touch. Structural so unit tests can
 * pass a plain object without pulling in the workers runtime.
 */
interface ShardRegistryDOState {
    /**
     * Concurrency-blocking initializer — `state.blockConcurrencyWhile(fn)`
     * delays the next fetch dispatch until `fn` resolves. We use it to load
     * the persisted snapshot exactly once at construction and to serialize
     * the read-modify-write spans in `register` / `unregister` so two
     * concurrent callers can't race the in-memory map.
     */
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>;
    storage: {
        get: <T = unknown>(key: string) => Promise<T | undefined>;
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
     * In-memory snapshot. The single `__tables__` key is persisted on every
     * mutation; the in-memory copy is the source of truth for reads so
     * `/list` never pays a storage round-trip.
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
     * Load the persisted snapshot exactly once. `blockConcurrencyWhile`
     * suspends concurrent fetch dispatches on this DO until the load
     * finishes, so the `loaded` flag doesn't need an additional mutex.
     */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        await this.state.blockConcurrencyWhile(async () => {
            if (this.loaded) {
                return;
            }

            const stored = await this.state.storage.get<PersistedTables>(STORAGE_KEY);

            if (stored) {
                for (const [table, keys] of Object.entries(stored)) {
                    this.tables.set(table, new Set(keys));
                }
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

        // Wrap the read-modify-write in `blockConcurrencyWhile` so two
        // concurrent `register` calls don't race the in-memory map and
        // persist a partial union. `ensureLoaded` runs outside this gate;
        // it has its own at the top of `fetch`.
        return this.state.blockConcurrencyWhile(async () => {
            let set = this.tables.get(table);

            if (!set) {
                set = new Set();
                this.tables.set(table, set);
            }

            if (set.has(shardKey)) {
                return jsonResponse({ changed: false, ok: true }, 200);
            }

            set.add(shardKey);
            await this.persist();

            return jsonResponse({ changed: true, ok: true }, 200);
        });
    }

    private handleSnapshot(): Response {
        const out: PersistedTables = {};

        for (const [table, set] of this.tables) {
            out[table] = [...set];
        }

        return jsonResponse({ tables: out }, 200);
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

            set.delete(shardKey);

            if (set.size === 0) {
                this.tables.delete(table);
            }

            await this.persist();

            return jsonResponse({ changed: true, ok: true }, 200);
        });
    }

    /** Serialize the in-memory map to a single JSON-safe object and put. */
    private async persist(): Promise<void> {
        const out: PersistedTables = {};

        for (const [table, set] of this.tables) {
            out[table] = [...set];
        }

        await this.state.storage.put(STORAGE_KEY, out);
    }
}

export { SHARD_REGISTRY_DO_NAME, ShardRegistryDO };
