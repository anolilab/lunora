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

import { LunoraError } from "@lunora/errors";
import type { DirectShardDirectory, ShardHost, ShardKvStore, ShardStub, SocketHost } from "@lunora/platform";

import type { DrainOptions, DrainResult } from "./drain-deadline";
import { settlesBefore, startDrainDeadline } from "./drain-deadline";
import { createNodeShardKvStore } from "./node-kv-store";
import { createNodeShardHost } from "./node-shard-host";
import type { NodeSocketHost } from "./node-socket-host";
import { createNodeSocketHost } from "./node-socket-host";

/** Extension used for a file-backed shard's database. */
const SHARD_FILE_SUFFIX = ".sqlite3";

/**
 * Encode a shard key into a filesystem-safe basename.
 *
 * Percent-encoding everything outside `[a-z0-9._-]` keeps simple keys readable
 * in a directory listing (`tenant-42.sqlite3`) while staying reversible and
 * safe for keys carrying `/`, `:` or spaces — all legal in a shard key, none
 * safe in a path segment.
 *
 * **Uppercase is escaped too**, which is the whole reason the class is not
 * `[^\w.-]`: APFS and NTFS both default to case-INSENSITIVE, so a
 * case-preserving encoding maps `Tenant` and `tenant` onto one file. Two
 * tenants would then get two `NodeShard` objects over two connections to the
 * same database and read each other's rows, with nothing throwing anywhere —
 * and `readdirSync` would yield one basename, so the fan-out key set would
 * silently hold one of the two keys. `node-r2-bucket`'s `ESCAPED_IN_SEGMENT`
 * escapes `A-Z` for exactly this reason.
 *
 * The escaped form cannot re-introduce the collision: hex digits are always
 * emitted uppercase and `%` is itself escaped, so every `%` in the output opens
 * an escape and two outputs that fold to the same string are identical.
 *
 * A database file written by an earlier build under the case-preserving
 * encoding no longer round-trips through this encoding, and the registry
 * refuses to boot over it — see {@link shardKeyForFile}. There is no
 * compatibility path here, because reading the old name back is exactly the
 * collision this encoding exists to prevent.
 *
 * Each disallowed code point is escaped as its **UTF-8 byte sequence** — one
 * `%XX` per byte, uppercase — because `decodeURIComponent` (which
 * `decodeShardKey` uses) only understands valid UTF-8 percent-escapes.
 * Escaping the Unicode code point instead (`é` → `%E9`) corrupts every key
 * whose character is not ASCII into an unparseable basename on the next
 * restart.
 */
const encodeShardKey = (key: string): string =>
    key.replaceAll(/[^\da-z._-]/gu, (character) =>
        [...Buffer.from(character, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join(""),
    );

/** Inverse of {@link encodeShardKey}. */
const decodeShardKey = (basename: string): string => decodeURIComponent(basename);

/**
 * The shard key a database file on disk stands for — or a hard failure.
 *
 * A basename only names a key if it *round-trips*: `encodeShardKey` of what it
 * decodes to must be the basename again. `Tenant.sqlite3`, written before
 * uppercase was escaped, decodes to `Tenant` and so joins the seeded key set —
 * but `shardFor("Tenant")` opens `%54enant.sqlite3`, a brand-new empty
 * database. `listShardKeys()` then reports a key whose every fan-out leg reads
 * zero rows and reports success, over a database still sitting in the same
 * directory. A migration or an export gets a clean report and no data.
 *
 * So this throws rather than skipping the file. Skipping is the same silent
 * emptiness one step removed: the key vanishes from the fan-out set and the
 * queries still succeed over nothing. A boot that names the file, the key, and
 * the exact `mv` costs one restart; the alternative costs an operator their
 * data with no signal at all.
 */
const shardKeyForFile = (directory: string, entry: string): string => {
    const basename = entry.slice(0, -SHARD_FILE_SUFFIX.length);
    const path = join(directory, entry);
    let key: string;

    try {
        key = decodeShardKey(basename);
    } catch {
        throw new LunoraError(
            "SHARD_UNAVAILABLE",
            `@lunora/platform-node: shard database "${path}" has a basename that is not valid percent-encoding, so the shard key it holds cannot be recovered. Rename or remove the file.`,
        );
    }

    const expected = `${encodeShardKey(key)}${SHARD_FILE_SUFFIX}`;

    if (expected !== entry) {
        throw new LunoraError(
            "SHARD_UNAVAILABLE",
            `@lunora/platform-node: shard database "${path}" was written under an older shard-key encoding. It decodes to shard key "${key}", which this build stores as "${expected}" — so the key would be listed for fan-out while every read opened a new, empty database. Rename it: mv "${path}" "${join(directory, expected)}"`,
        );
    }

    return key;
};

/** What one shard still has running when a drain looks. */
interface ShardWorkCounts {
    alarms: number;
    background: number;
    closing: boolean;
    requests: number;
}

const countOf = (amount: number, one: string, many: string): string => {
    if (amount === 0) {
        return "";
    }

    return `${String(amount)} ${amount === 1 ? one : many}`;
};

/** `shard <key>: 1 request in flight, 2 waitUntil tasks`: counts only, never a request or payload. */
const describeShardWork = (key: string, pending: ShardWorkCounts): string => {
    const parts = [
        countOf(pending.requests, "request in flight", "requests in flight"),
        countOf(pending.alarms, "alarm running", "alarms running"),
        countOf(pending.background, "waitUntil task", "waitUntil tasks"),
        pending.closing ? "a socket close handler running" : "",
    ].filter((part) => part !== "");

    return `shard ${key}: ${parts.join(", ")}`;
};

/** The contracts scoped to one shard key. */
export interface NodeShard {
    /**
     * Inbound socket events for this shard's registry. Bind the shard that owns
     * the sockets here, so a frame or close reaches its `webSocketMessage` and
     * `webSocketClose`. See `bindShardSockets`.
     */
    inbound: Pick<NodeSocketHost, "onClose" | "onMessage">;
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
    /**
     * Dispose every live shard. Safe to call more than once. A shard whose socket close handler is still running is disposed
     * once it settles, unless `force` is set: then it is disposed now and named in a log line. A shutdown passes `force` after
     * its drain has finished or reached its deadline, so a handler that never settles cannot keep a database open at exit.
     */
    close: (options?: { force?: boolean }) => void;
    /** The `ShardDirectory` to hand the runtime. */
    directory: DirectShardDirectory;

    /**
     * Wait until every shard is idle: no `onFetch` or `onAlarm` call in flight (a cron or scheduled job's delivery is one), no
     * promise handed to a shard's `waitUntil` pending, and no socket close handler still running, across every live shard,
     * including one opened while draining. Work that starts more work is waited for too. Bounded by `timeoutMs` (30 s by
     * default); resolves with what was still running when it passed, which it also logs. A graceful shutdown awaits this, then
     * calls {@link NodeShardRegistry.close}; `close()` alone does not wait for any of it.
     */
    drain: (options?: DrainOptions) => Promise<DrainResult>;

    /**
     * Whether every shard is idle right now (nothing a {@link NodeShardRegistry.drain} would wait for). Synchronous, so a caller
     * that drained several things can confirm all of them are still idle at one instant before it closes anything.
     */
    idle: () => boolean;

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
    const live = new Map<
        string,
        {
            dispose: () => void;
            drain: () => Promise<void> | undefined;
            drainHost: () => Promise<void>;
            pendingAlarms: () => number;
            pendingBackground: () => number;
            shard: NodeShard;
            takeFailures: () => string[];
        }
    >();

    /**
     * `onFetch` calls still running, with their shard, so {@link NodeShardRegistry.drain} can wait for them and say what it cut
     * off. Never the request itself: its URL or body can carry a secret. Alarms are tracked by their host, through the retry.
     */
    const inFlight = new Map<Promise<unknown>, { shardKey: string }>();

    const track = async <T>(call: { shardKey: string }, work: () => Promise<T> | T): Promise<T> => {
        const running = Promise.resolve().then(work);
        // Tracking only: the caller still receives `running` and its rejection.
        const settled = running.then(
            () => undefined,
            () => undefined,
        );

        inFlight.set(settled, call);

        settled.finally(() => inFlight.delete(settled)).catch(() => undefined);

        return running;
    };

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
                known.add(shardKeyForFile(options.directory, entry));
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
            drain: drainHost,
            host,
            pendingAlarms,
            pendingBackground,
            takeFailures,
        } = createNodeShardHost({
            // The host tracks each alarm delivery through its retry write, which a wrapper here would settle before.
            onAlarm: () => options.onAlarm?.(shard),
            path,
            shardKey: key,
        });

        const socketHost = createNodeSocketHost(database);

        shard = {
            inbound: socketHost,
            kv: createNodeShardKvStore(database),
            shard: host,
            shardKey: key,
            sockets: socketHost.socket,
        };

        live.set(key, { dispose: disposeHost, drain: socketHost.drain, drainHost, pendingAlarms, pendingBackground, shard, takeFailures });
        known.add(key);

        return shard;
    };

    const stubFor = (key: string): ShardStub => {
        return {
            fetch: async (request) => {
                const shard = shardFor(key);

                const { onFetch } = options;

                if (onFetch === undefined) {
                    return new Response(key);
                }

                return track({ shardKey: key }, () => onFetch(request, shard));
            },
        };
    };

    // What is still running, across every shard live now: re-read on each pass, so a shard opened during the last
    // pass, or one that gained background work after its own drain resolved, is seen.
    /** Every live shard's recorded failures, cleared as they are reported. */
    const takeAllFailures = (): string[] => [...live.values()].flatMap((entry) => entry.takeFailures());

    const pendingWork = (): { labels: string[]; waits: Promise<unknown>[] } => {
        const counts = new Map<string, ShardWorkCounts>();
        const countsFor = (shardKey: string): ShardWorkCounts => {
            let entry = counts.get(shardKey);

            if (entry === undefined) {
                entry = { alarms: 0, background: 0, closing: false, requests: 0 };
                counts.set(shardKey, entry);
            }

            return entry;
        };
        const waits: Promise<unknown>[] = [...inFlight.keys()];

        for (const call of inFlight.values()) {
            countsFor(call.shardKey).requests += 1;
        }

        for (const [key, entry] of live) {
            const closing = entry.drain();
            const background = entry.pendingBackground();
            const alarmDeliveries = entry.pendingAlarms();

            if (closing !== undefined) {
                countsFor(key).closing = true;
                waits.push(closing);
            }

            if (background > 0) {
                countsFor(key).background = background;
            }

            if (alarmDeliveries > 0) {
                countsFor(key).alarms = alarmDeliveries;
            }

            if (background > 0 || alarmDeliveries > 0) {
                waits.push(entry.drainHost());
            }
        }

        // One line per shard: its key and how much of each kind of work is left, so a cut-off drain is attributable.
        const labels = [...counts].map(([key, pending]) => describeShardWork(key, pending));

        return { labels, waits };
    };

    return {
        close: (closeOptions) => {
            const forced: string[] = [];
            const failed: { error: unknown; key: string }[] = [];

            // One shard failing to close must not leave the rest open: each is disposed on its own, and failures are reported
            // together once every shard has been tried.
            const dispose = (key: string, entry: { dispose: () => void }): void => {
                try {
                    entry.dispose();
                } catch (error: unknown) {
                    failed.push({ error, key });
                }
            };

            for (const [key, entry] of live) {
                // A route's close handler may still be writing; the database is disposed only once it settles. Forced (after a
                // drain's deadline) it is disposed now: a handler that never settles must not keep its database open at exit.
                const pending = entry.drain();

                if (pending === undefined) {
                    dispose(key, entry);
                } else if (closeOptions?.force === true) {
                    forced.push(key);
                    dispose(key, entry);
                } else {
                    pending
                        .finally(() => {
                            dispose(key, entry);
                        })
                        .catch(() => undefined);
                }
            }

            live.clear();

            if (forced.length > 0) {
                // eslint-disable-next-line no-console -- these shards are closed under a running handler, so the log is the only record of it
                console.error("[@lunora/platform-node] closed %d shard(s) with a socket close handler still running: %s", forced.length, forced.join(", "));
            }

            for (const { error, key } of failed) {
                // eslint-disable-next-line no-console -- the caller gets one aggregate error; each shard's own cause is recorded here
                console.error("[@lunora/platform-node] shard %s failed to close", key, error);
            }

            if (failed.length > 0) {
                throw new AggregateError(
                    failed.map(({ error }) => error),
                    `@lunora/platform-node: ${String(failed.length)} shard(s) failed to close: ${failed.map(({ key }) => key).join(", ")}`,
                );
            }
        },
        drain: async (drainOptions?: DrainOptions): Promise<DrainResult> => {
            const deadline = startDrainDeadline(drainOptions);

            try {
                // Done only when a full pass over every shard finds nothing running, not when the work one pass saw settles.
                for (let work = pendingWork(); work.waits.length > 0; work = pendingWork()) {
                    // Settled, not all-or-nothing: one shard's failure must not stop the drain from waiting for the others.
                    // eslint-disable-next-line no-await-in-loop -- each pass waits for what it found before looking again
                    if (!(await settlesBefore(Promise.allSettled(work.waits), deadline))) {
                        const pending = pendingWork().labels;

                        // eslint-disable-next-line no-console -- the drain gives up on these, so the log is the only record of what was cut off
                        console.error("[@lunora/platform-node] shard drain deadline passed with work still running: %s", pending.join(", "));

                        return { failed: takeAllFailures(), pending, timedOut: true };
                    }
                }

                return { failed: takeAllFailures(), pending: [], timedOut: false };
            } finally {
                deadline.cancel();
            }
        },
        directory: {
            get: (id) => stubFor(String(id)),
            getByName: (name) => stubFor(name),
            // The key itself. There is nothing to hide behind an opaque id — no
            // cross-node routing, no jurisdiction — and the contract types `id`
            // as `unknown`, so this is a legitimate if degenerate choice.
            idForName: (name) => name,
        },
        idle: () => pendingWork().waits.length === 0,
        listShardKeys: () => [...known],
        shardFor,
    };
};
