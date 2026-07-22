import type { Notification, Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";

import type { D1Like, D1PreparedLike } from "../src/subscriptions/d1-store";

/**
 * A mock push `Provider` whose outcome is driven by the target text: a target
 * containing `gone` fails with a structured HTTP 410 (pruned by the facade), `fail`
 * fails with a transient 503 (kept + marked failed), anything else succeeds.
 * Mirrors the real web-push provider's failure phrasing so tests exercise the
 * structured gone-signal path. Records every send.
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

            if (target.includes("gone")) {
                return { error: new Error("Subscription gone (HTTP 410) — remove this subscription"), success: false };
            }

            if (target.includes("fail")) {
                return { error: new Error("503 transient upstream error"), success: false };
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

/** Build a `Notification` engine wired only with the given mock providers. */
const mockEngine = (providers: { chat?: Provider; push?: Provider<unknown, PushPayload> }): Notification =>
    createNotification({ chat: providers.chat, push: providers.push });

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
 * A minimal functional fake of the D1 slice the subscription store uses. Branches
 * on the statement text (CREATE/INSERT…ON CONFLICT/SELECT/DELETE/UPDATE) against
 * an in-memory row map — enough to exercise the store's row&lt;->object mapping,
 * upsert-preserves-createdAt, and filtered listing.
 */
const fakeD1 = (): D1Like => {
    const rows = new Map<string, FakeRow>();

    const prepared = (sql: string): D1PreparedLike => {
        let bound: unknown[] = [];

        const self: D1PreparedLike = {
            all: async <T = Record<string, unknown>>() => {
                let results = [...rows.values()];

                if (sql.includes("kind = ?")) {
                    const kind = bound[0];

                    results = results.filter((row) => row.kind === kind);
                }

                if (sql.includes("user_id IS NULL")) {
                    results = results.filter((row) => row.user_id === null);
                } else if (sql.includes("user_id = ?")) {
                    const userId = bound.at(-1);

                    results = results.filter((row) => row.user_id === userId);
                }

                return { results: results as T[] };
            },
            bind: (...values: unknown[]) => {
                bound = values;

                return self;
            },
            first: async <T = Record<string, unknown>>() => {
                const row = rows.get(bound[0] as string);

                return (row ?? null) as T | null;
            },
            run: async () => {
                if (sql.startsWith("CREATE TABLE")) {
                    return undefined;
                }

                if (sql.startsWith("INSERT")) {
                    const [id, kind, endpoint, p256dh, auth, token, userId, metadata, createdAt, lastSeenAt, lastStatus, lastError] = bound;
                    const existing = rows.get(id as string);

                    rows.set(id as string, {
                        auth: auth as string | null,
                        created_at: (existing?.created_at ?? createdAt) as number,
                        endpoint: endpoint as string | null,
                        id: id as string,
                        kind: kind as string,
                        last_error: lastError as string | null,
                        last_seen_at: lastSeenAt as number,
                        last_status: lastStatus as string | null,
                        metadata: metadata as string | null,
                        p256dh: p256dh as string | null,
                        token: token as string | null,
                        user_id: userId as string | null,
                    });

                    return undefined;
                }

                if (sql.startsWith("DELETE")) {
                    rows.delete(bound[0] as string);

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

export { fakeD1, mockChatProvider, mockEngine, mockPushProvider };
