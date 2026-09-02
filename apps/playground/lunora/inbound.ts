import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { dbRateLimit } from "@lunora/ratelimit";

// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

// A global cap (no per-key bucket) on inbound-email ingestion — 100/minute.
const limits = { onEmail: { kind: "fixed window", period: 60_000, rate: 100 } } satisfies RateLimitConfigMap;

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
export const onEmail = mutation
    .input({
        from: v.string().max(320),
        messageId: v.optional(v.string().max(256)),
        receivedAt: v.number(),
        subject: v.optional(v.string().max(512)),
        text: v.optional(v.string().max(100_000)),
        to: v.array(v.string().max(320)),
    })
    .use(dbRateLimit(limits, "onEmail"))
    .mutation(async ({ args, ctx }): Promise<Id<"inbox">> => {
        const { from, messageId, receivedAt, subject, text, to } = args;

        const inboxId = await ctx.db.insert("inbox", {
            body: text ?? "",
            from,
            messageId: messageId ?? "",
            receivedAt,
            subject: subject ?? "",
            to,
        });

        // After the insert, and counts only. The body is user content and the
        // addresses are contact data — neither belongs in a log line.
        ctx.log.info("inbound email stored", { characters: text?.length ?? 0, recipients: to.length });

        return inboxId;
    });

/** Most-recently-received inbox messages, newest first via the `by_received` index. */
export const list = query.input({ limit: v.optional(v.number()) }).query(async ({ args, ctx }): Promise<Doc<"inbox">[]> =>
    ctx.db
        .query("inbox")
        .withIndex("by_received")
        .order("desc")
        .take(args.limit ?? 50),
);
