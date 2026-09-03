import type { InAppPayload } from "@visulima/notification";

/**
 * SPIKE (plan 241): types for the in-app inbox READ half's prototype store.
 * This is a design/prototype seam, not yet wired into `createNotify` /
 * `ctx.notify` — see `plans/241-inapp-inbox-design.md` for the write-coupling,
 * query surface, and open questions (D1 backend, live delivery, retention)
 * this prototype deliberately leaves unresolved. Only a MEMORY backend exists
 * so far; do not treat this as a stable public surface yet.
 */

/**
 * An in-app inbox payload: an {@link InAppPayload} without `to` — the owning
 * {@link InboxItem.userId} already carries the recipient, mirroring how
 * `PushContent` drops `PushPayload.to` for the same reason (`../types.ts`).
 */
export type InboxContent = Omit<InAppPayload, "to">;

/**
 * One persisted in-app notification. `id` is a store-assigned, monotonically
 * SORTABLE identifier (ascending = chronological) — the memory store mints a
 * zero-padded counter; a real backend would use an equivalent (ULID, a D1
 * autoincrement rowid, …). Sortability is what lets `listInbox` page
 * newest-first with an exclusive cursor, mirroring plan 222's
 * `SubscriptionFilter.after` keyset-pagination shape.
 */
export interface InboxItem {
    /** Optional coarse category for filtering (e.g. `"billing"`, `"social"`). Grouping/collapsing policy is an open question — see the design doc. */
    category?: string;
    /** Unix-ms time the item was appended. */
    createdAt: number;
    /** Optional key for client-side collapsing of related items (e.g. `"comment:42"`). Not interpreted by the store itself. */
    groupKey?: string;
    /** Store-assigned, sortable identifier. */
    id: string;
    /** The in-app content (title/body/data/actions). */
    payload: InboxContent;
    /** Unix-ms time the item was read, or `undefined` while unread. */
    readAt?: number;
    /** The owning user — unlike a device subscription, an inbox item always has a specific, non-anonymous recipient. */
    userId: string;
}

/** Input to {@link InboxStore.append}. */
export interface AppendInboxInput {
    /** Optional coarse category (see {@link InboxItem.category}). */
    category?: string;
    /** Optional client-collapsing key (see {@link InboxItem.groupKey}). */
    groupKey?: string;
    /** The in-app content to persist. */
    payload: InboxContent;
    /** The owning user. */
    userId: string;
}

/**
 * Filter/pagination for {@link InboxStore.list}. Reuses plan 222's cursor
 * shape (`after` + `limit`) but the ORDER is reversed: `listInbox` is
 * newest-first (a notification center shows recent items on top), so `after`
 * means "strictly OLDER than this cursor" — the id of the last item on the
 * previous page — rather than "greater than", matching what a `list`-then-
 * "load older" pagination UI needs.
 */
export interface ListInboxFilter {
    /** Cursor: return only items older than this item id (exclusive), newest-first order. */
    after?: string;
    /** Cap the number of rows returned. A non-positive/absent value means "no cap". */
    limit?: number;
    /** Restrict to unread items only (`readAt === undefined`). */
    unreadOnly?: boolean;
}

/**
 * Persistence for the in-app inbox READ half (plan 241 spike). A MEMORY
 * implementation exists ({@link import("./memory-store").memoryInboxStore});
 * a D1 (or other durable) backend is design-only for now — see
 * `plans/241-inapp-inbox-design.md`.
 */
export interface InboxStore {
    /** Persist a new in-app notification for `input.userId` and return the stored item. */
    append: (input: AppendInboxInput) => Promise<InboxItem>;
    /** List `userId`'s items, newest-first, optionally filtered/paged (see {@link ListInboxFilter}). */
    list: (userId: string, filter?: ListInboxFilter) => Promise<InboxItem[]>;
    /** Mark all of `userId`'s currently-unread items as read; returns how many were changed. */
    markAllRead: (userId: string) => Promise<number>;
    /** Mark one of `userId`'s items as read by id (idempotent — a no-op if already read, unknown, or owned by someone else). */
    markRead: (userId: string, id: string) => Promise<void>;
    /** Count `userId`'s unread items. */
    unreadCount: (userId: string) => Promise<number>;
}
