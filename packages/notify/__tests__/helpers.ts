import type { Notification, Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";

import { attachResilience } from "../src/providers";
import type { D1Like, D1PreparedLike } from "../src/subscriptions/d1-store";

/**
 * The message the `@visulima/notification` FCM provider ACTUALLY produces for a
 * dead device token, verbatim.
 *
 * Its send path forwards `body.error.message` and nothing else, and FCM HTTP v1
 * reports an unregistered token as HTTP 404 with `error.status: "NOT_FOUND"`,
 * `error.message: "Requested entity was not found."` and the canonical
 * `UNREGISTERED` code buried in `error.details[].errorCode` — which the provider
 * drops. The engine then prefixes it via `NotificationError`. A double answering
 * an invented `"FCM push failed: UNREGISTERED"` agrees with the code and disagrees
 * with FCM: no such string ever reaches `isGoneError`.
 */
const FCM_DEAD_TOKEN_ERROR = "[@visulima/notification] [fcm] Requested entity was not found.";

/**
 * A mock push `Provider` whose outcome is driven by the target text: a target
 * containing `gone` fails with its provider's real permanently-gone phrasing
 * (pruned by the facade), `fail` fails with a transient 503 (kept + marked
 * failed), anything else succeeds. Records every send.
 *
 * The gone phrasing is chosen PER KIND, because the two providers word it
 * differently and only one of them mentions a status code at all: a web-push
 * target (the JSON-stringified subscription) gets `Subscription gone (HTTP 410)`,
 * an FCM target (an opaque token) gets {@link FCM_DEAD_TOKEN_ERROR}. A double that
 * answered the web-push phrasing for both never exercised FCM pruning at all.
 */
const mockPushProvider = (): { provider: Provider<unknown, PushPayload>; sends: PushPayload[] } => {
    const sends: PushPayload[] = [];

    const provider: Provider<unknown, PushPayload> = {
        channel: "push",
        id: "mock-push",
        initialize: () => undefined,
        isAvailable: () => true,
        send: (payload) => {
            sends.push(payload);

            const target = Array.isArray(payload.to) ? payload.to.join(",") : payload.to;
            // A web-push target is the JSON-stringified subscription; an FCM target
            // is an opaque registration token. The same split the router itself makes.
            const isFcm = !target.startsWith("{");

            if (target.includes("gone")) {
                return {
                    error: new Error(isFcm ? FCM_DEAD_TOKEN_ERROR : "Subscription gone (HTTP 410) — remove this subscription"),
                    success: false,
                };
            }

            if (target.includes("fail")) {
                return { error: new Error("503 transient upstream error"), success: false };
            }

            return { data: { messageId: `mock-${sends.length.toString()}`, sent: true, timestamp: new Date() }, success: true };
        },
    };

    return { provider, sends };
};

/**
 * A mock push `Provider` that THROWS synchronously for any target containing
 * `throw` (and succeeds otherwise) — the transient-provider-error path a broadcast
 * must tolerate without aborting the whole fan-out. Records every attempted send.
 */
const mockThrowingPushProvider = (): { provider: Provider<unknown, PushPayload>; sends: PushPayload[] } => {
    const sends: PushPayload[] = [];

    const provider: Provider<unknown, PushPayload> = {
        channel: "push",
        id: "mock-throwing-push",
        initialize: () => undefined,
        isAvailable: () => true,
        send: (payload) => {
            sends.push(payload);

            const target = Array.isArray(payload.to) ? payload.to.join(",") : payload.to;

            if (target.includes("throw")) {
                throw new Error("boom: push provider threw");
            }

            return { data: { messageId: `mock-${sends.length.toString()}`, sent: true, timestamp: new Date() }, success: true };
        },
    };

    return { provider, sends };
};

/** A mock chat provider that always succeeds, for multi-channel/chat tests. */
const mockChatProvider = (): Provider => {
    return {
        channel: "chat",
        id: "mock-chat",
        initialize: () => undefined,
        isAvailable: () => true,
        send: () => {
            return { data: { messageId: "chat-1", sent: true, timestamp: new Date() }, success: true };
        },
    };
};

/**
 * Build a `Notification` engine wired with the given mock providers AND the same
 * resilience middleware production uses — via `attachResilience` itself, not a
 * copy of it.
 *
 * A bare `createNotification(...)` here is why the retry/circuit-breaker wiring
 * went unexercised: every test drove a chain with no middleware in it, so a
 * recipient the facade was about to prune still cost four POSTs, and the shared
 * breaker's effect on unrelated channels was invisible.
 *
 * `retryBaseDelay: 0` is the ONE deviation: these doubles fail deliberately, and
 * the production backoff would spend ~2 s per failing recipient to demonstrate
 * something the delay has no bearing on — which results get retried at all.
 */
const mockEngine = (providers: { chat?: Provider; push?: Provider<unknown, PushPayload> }): Notification =>
    attachResilience(createNotification({ chat: providers.chat, push: providers.push }), { retryBaseDelay: 0 });

interface FakeRow {
    auth: string | null;
    created_at: number;
    endpoint: string | null;
    id: string;
    kind: string;
    last_error: string | null;
    last_seen_at: number;
    last_status: string | null;
    metadata: string | null;
    p256dh: string | null;
    token: string | null;
    user_id: string | null;
}

/**
 * Whether a `DELETE`'s owner predicate matches `row`.
 *
 * The store writes THREE shapes, and they mean different things: no `user_id`
 * clause (the internal gone-prune), `AND user_id IS NULL` / `AND user_id = ?2`
 * (`deleteOwned`'s exact-match ownership), and `AND (user_id IS NULL OR user_id =
 * ?2)` (the legacy-row eviction's claim predicate, which must also take an unowned
 * row). A fake that answers one rule for all three cannot tell a store that evicts
 * an unowned legacy row from one that strands it as a permanent duplicate.
 */
const deleteMatches = (sql: string, row: FakeRow | undefined, bound: ReadonlyArray<unknown>): boolean => {
    if (row === undefined) {
        return false;
    }

    if (!sql.includes("user_id")) {
        return true;
    }

    const owner = (bound[1] ?? null) as string | null;

    if (sql.includes("user_id IS NULL OR")) {
        return row.user_id === null || row.user_id === owner;
    }

    return sql.includes("user_id IS NULL") ? row.user_id === null : row.user_id === owner;
};

/**
 * Whether an `ON CONFLICT … DO UPDATE … WHERE` refuses the update for the row it
 * conflicts with.
 *
 * SQLite applies that `WHERE` to the CONFLICTING row and, when it is false, leaves
 * the row untouched — no update, and no error either. Modelling it is what makes a
 * cross-owner re-register observable here at all: a fake that always overwrites
 * reports the store as having re-owned the row whatever predicate the statement
 * carries.
 */
const upsertRefused = (sql: string, existing: FakeRow | undefined, userId: unknown): boolean =>
    existing !== undefined && sql.includes("DO UPDATE") && sql.includes("user_id IS NULL OR") && existing.user_id !== null && existing.user_id !== userId;

/**
 * The row an accepted upsert leaves behind, given the conflicting row (if any) and
 * the statement's bindings in the order the store appends them.
 *
 * `created_at` and `last_status`/`last_error` survive a re-register because the
 * real `DO UPDATE SET` list omits those columns — a fresh registration carries no
 * status, and `markStatus` stays their only writer.
 */
const upsertedRow = (existing: FakeRow | undefined, bound: ReadonlyArray<unknown>): FakeRow => {
    const [id, kind, endpoint, p256dh, auth, token, userId, metadata, createdAt, lastSeenAt, lastStatus, lastError] = bound;

    return {
        auth: auth as string | null,
        created_at: (existing?.created_at ?? createdAt) as number,
        endpoint: endpoint as string | null,
        id: id as string,
        kind: kind as string,
        last_error: (existing === undefined ? lastError : existing.last_error) as string | null,
        last_seen_at: lastSeenAt as number,
        last_status: (existing === undefined ? lastStatus : existing.last_status) as string | null,
        metadata: metadata as string | null,
        p256dh: p256dh as string | null,
        token: token as string | null,
        user_id: userId as string | null,
    };
};

/** Ascending `id` comparator — mirrors the real store's `ORDER BY id ASC`. */
const compareById = (a: { id: string }, b: { id: string }): number => {
    if (a.id < b.id) {
        return -1;
    }

    return a.id > b.id ? 1 : 0;
};

/**
 * A minimal functional fake of the D1 slice the subscription store uses. Branches
 * on the statement text (CREATE/INSERT…ON CONFLICT/SELECT/DELETE/UPDATE) against
 * an in-memory row map — enough to exercise the store's row<->object mapping,
 * upsert-preserves-createdAt, and filtered listing.
 */
/** Options for {@link fakeD1}. `failOn` injects a store error on the matching SQL verb. */
interface FakeD1Options {
    failOn?: "DELETE" | "INSERT" | "SELECT" | "UPDATE";
}

const fakeD1 = (options: FakeD1Options = {}): D1Like => {
    const rows = new Map<string, FakeRow>();
    // A statement whose leading verb matches `failOn` rejects — the transient
    // store-error path (e.g. a failing `markStatus` UPDATE) the facade must tolerate.
    const shouldFail = (sql: string): boolean => options.failOn !== undefined && sql.trimStart().toUpperCase().startsWith(options.failOn);

    const prepared = (sql: string): D1PreparedLike => {
        let bound: unknown[] = [];

        const self: D1PreparedLike = {
            all: async <T = Record<string, unknown>>() => {
                if (shouldFail(sql)) {
                    throw new Error(`fakeD1: injected failure on ${options.failOn ?? ""}`);
                }

                let results = [...rows.values()];
                // Consume bindings in the same order the store appends them:
                // [kind?, userId?, after?, limit?]. A cursor keeps the filters
                // correct even when a trailing `LIMIT ?` binding is present.
                let cursor = 0;

                if (sql.includes("kind = ?")) {
                    const kind = bound[cursor];

                    cursor += 1;
                    results = results.filter((row) => row.kind === kind);
                }

                if (sql.includes("user_id IS NULL")) {
                    results = results.filter((row) => row.user_id === null);
                } else if (sql.includes("user_id = ?")) {
                    const userId = bound[cursor];

                    cursor += 1;
                    results = results.filter((row) => row.user_id === userId);
                }

                if (sql.includes("id > ?")) {
                    const after = bound[cursor] as string;

                    cursor += 1;
                    results = results.filter((row) => row.id > after);
                }

                if (sql.includes("ORDER BY id ASC")) {
                    results = results.toSorted(compareById);
                }

                if (sql.includes("LIMIT ?")) {
                    results = results.slice(0, bound[cursor] as number);
                }

                return { results: results as T[] };
            },
            bind: (...values: unknown[]) => {
                bound = values;

                return self;
            },
            first: async <T = Record<string, unknown>>() => {
                if (shouldFail(sql)) {
                    throw new Error(`fakeD1: injected failure on ${options.failOn ?? ""}`);
                }

                const row = rows.get(bound[0] as string);

                // `deleteOwned` is a `DELETE … WHERE id = ? AND user_id …
                // RETURNING id`, and it reads its result through `first()`. A fake
                // that answered it with the row for ANY id — without applying the
                // owner predicate and without deleting anything — reports every
                // owner check as a match and every removal as having happened, so
                // the first test written against it passes for the wrong reason.
                if (sql.trimStart().toUpperCase().startsWith("DELETE")) {
                    if (row === undefined || !deleteMatches(sql, row, bound)) {
                        return null;
                    }

                    rows.delete(row.id);

                    return { id: row.id } as T;
                }

                return (row ?? null) as T | null;
            },
            run: async () => {
                if (shouldFail(sql)) {
                    throw new Error(`fakeD1: injected failure on ${options.failOn ?? ""}`);
                }

                if (sql.startsWith("CREATE TABLE")) {
                    return undefined;
                }

                if (sql.startsWith("INSERT")) {
                    const existing = rows.get(bound[0] as string);

                    if (upsertRefused(sql, existing, bound[6])) {
                        return undefined;
                    }

                    const row = upsertedRow(existing, bound);

                    rows.set(row.id, row);

                    return undefined;
                }

                if (sql.startsWith("DELETE")) {
                    // The legacy-row eviction carries an owner predicate, so a fake
                    // that deletes by id alone reports the store as having removed a
                    // row it is not allowed to touch.
                    const row = rows.get(bound[0] as string);

                    if (row !== undefined && deleteMatches(sql, row, bound)) {
                        rows.delete(row.id);
                    }

                    return undefined;
                }

                if (sql.startsWith("UPDATE")) {
                    const existing = rows.get(bound[0] as string);

                    if (existing !== undefined) {
                        existing.last_status = bound[1] as string | null;
                        existing.last_error = bound[2] as string | null;
                        existing.last_seen_at = bound[3] as number;
                    }

                    return undefined;
                }

                return undefined;
            },
        };

        return self;
    };

    return { prepare: prepared };
};

export { compareById, fakeD1, FCM_DEAD_TOKEN_ERROR, mockChatProvider, mockEngine, mockPushProvider, mockThrowingPushProvider };
