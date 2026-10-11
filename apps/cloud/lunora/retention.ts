import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation } from "./_generated/server.js";
import { ERASED_REFERENCE } from "./purge";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an anonymised payment or subscription row is kept. Invoices and the
 * books they belong to are kept for the statutory period (AO § 147, HGB § 257).
 * The period has been reported as 8 years from 2025 and was 10 before; the longer
 * reading is used until the current text is confirmed, so no record is removed early.
 */
export const FINANCIAL_RETENTION_MS = 10 * 365 * DAY_MS;

/**
 * How long a payment webhook is kept for de-duplication. Providers retry for a few
 * days at most; 90 days leaves a wide margin and holds no personal data.
 */
export const WEBHOOK_EVENT_RETENTION_MS = 90 * DAY_MS;

/**
 * How long an audit entry is kept. Three years matches the regular limitation
 * period (§ 195 BGB), the window in which an entry can be needed as evidence.
 */
export const AUDIT_LOG_RETENTION_MS = 3 * 365 * DAY_MS;

/** Rows deleted per table per tick. A backlog drains over several ticks. */
const PRUNE_BATCH = 200;

/** The two financial tables, typed as one facade shape each (the union of the two is not callable). */
const financialFacades = (context: MutationContext): ReadonlyArray<FindManyFacade> => [
    context.db.payment_sessions as unknown as FindManyFacade,
    context.db.payment_subscriptions as unknown as FindManyFacade,
];

interface FindManyFacade {
    findMany: (query: {
        limit: number;
        orderBy: ReadonlyArray<Record<string, "asc" | "desc">>;
        where: Record<string, unknown>;
    }) => Promise<{ page: { _id: string }[] }>;
}

/**
 * Delete rows past their retention window: anonymised payment and subscription
 * rows, payment webhook events, and audit entries. Runs on the 6-hour cron.
 * SYSTEM only.
 */
export const prune = internalMutation.mutation(async ({ ctx: context }): Promise<{ auditLog: number; events: number; financial: number }> => {
    const financialCutoff = context.now - FINANCIAL_RETENTION_MS;
    let financial = 0;

    for (const facade of financialFacades(context)) {
        // The redacted reference marks a row whose organization was erased; a
        // live row is never swept here.
        // eslint-disable-next-line no-await-in-loop -- one table at a time keeps the writer simple
        const { page: stale } = await facade.findMany({
            limit: PRUNE_BATCH,
            orderBy: [{ updatedAt: "asc" }],
            where: { referenceId: ERASED_REFERENCE, updatedAt: { lt: financialCutoff } },
        });

        for (const row of stale) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential deletes keep the writer simple
            await context.db.delete(row._id as never);
        }

        financial += stale.length;
    }

    const { page: events } = await context.db.payment_events.findMany({
        limit: PRUNE_BATCH,
        orderBy: [{ processedAt: "asc" }],
        where: { processedAt: { lt: context.now - WEBHOOK_EVENT_RETENTION_MS } },
    });

    for (const row of events) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential deletes keep the writer simple
        await context.db.delete(row._id);
    }

    const { page: entries } = await context.db.auditLog.findMany({
        limit: PRUNE_BATCH,
        orderBy: [{ createdAt: "asc" }],
        where: { createdAt: { lt: context.now - AUDIT_LOG_RETENTION_MS } },
    });

    for (const row of entries) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential deletes keep the writer simple
        await context.db.delete(row._id);
    }

    return { auditLog: entries.length, events: events.length, financial };
});
