import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";

/**
 * Persist an inbound email into the `inbox` table.
 *
 * Targeted by the worker entry's `email()` export (see
 * `apps/playground/src/server/index.ts`): the `@lunora/mail/inbound` handler
 * parses the received message and dispatches it here as `inbound:onEmail` over
 * the root shard's admin RPC. The args mirror the `InboundEmail` fields the
 * playground's `resolveArgs` projects — a mutation validates its args strictly,
 * so the dispatcher narrows the parsed message to exactly these.
 *
 * The write lands on the root DO's SQLite, so it *is* on the change-feed: the
 * {@link list} query below re-runs for any live subscriber when new mail arrives.
 *
 * `receivedAt` is taken as an arg rather than read from `Date.now()` here — a
 * mutation handler must be deterministic, so the worker entry's `resolveArgs`
 * stamps the receive time (the correct place for the ambient clock call).
 */
export const onEmail = mutation({
    args: {
        from: v.string(),
        messageId: v.optional(v.string()),
        receivedAt: v.number(),
        subject: v.optional(v.string()),
        text: v.optional(v.string()),
        to: v.array(v.string()),
    },
    handler: async (context, { from, messageId, receivedAt, subject, text, to }): Promise<Id<"inbox">> =>
        context.db.insert("inbox", {
            body: text ?? "",
            from,
            messageId: messageId ?? "",
            receivedAt,
            subject: subject ?? "",
            to,
        }),
});

/** Most-recently-received inbox messages, newest first via the `by_received` index. */
export const list = query({
    args: { limit: v.optional(v.number()) },
    handler: async (context, { limit }): Promise<Doc<"inbox">[]> => {
        const rows = await context.db
            .query("inbox")
            .withIndex("by_received")
            .order("desc")
            .take(limit ?? 50);

        return rows as unknown as Doc<"inbox">[];
    },
});
