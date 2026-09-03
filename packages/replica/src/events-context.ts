/**
 * `eventsContext` — Middleware that attaches a typed `ctx.events` facade
 * backed by an {@link EventLogDOClient}.
 *
 * Drop it into a `.use()` chain on any mutation/action/query to give the
 * handler access to the event log without reaching for the DO client directly.
 *
 * ## Usage
 *
 * ```ts
 * import { eventsContext } from "@lunora/replica";
 * import { EventLogDOClient } from "@lunora/replica";
 *
 * const client = new EventLogDOClient({
 *   fetch: (req) => env.EVENT_LOG_DO.get(id).fetch(req),
 * });
 *
 * export const track = mutation
 *   .use(eventsContext(client))
 *   .mutation(async ({ ctx, args }) => {
 *     await ctx.events.append([{ type: "user.didThing", payload: args }]);
 *   });
 * ```
 */
import type { Middleware } from "@lunora/server";

import type { EventLogEntry } from "./event-log";
import type { EventLogDOClient } from "./event-log-do-client";

// ── Events facade types ────────────────────────────────────────────────

/**
 * The per-request `ctx.events` facade that {@link eventsContext} attaches.
 *
 * Each method delegates to the corresponding {@link EventLogDOClient} method,
 * so handlers never need to import or reference the DO client directly.
 * @experimental
 */
export interface EventsFacade {
    /**
     * Append one or more events to the log.
     * @returns The persisted entries with their assigned `seq` numbers.
     */
    append: (events: { payload: unknown; timestamp?: number; type: string }[]) => Promise<EventLogEntry[]>;

    /**
     * Fetch ONE bounded page of entries with `seq >= sinceSeq`.
     * @returns `{ entries, truncated, cursor }` — pass `cursor` back as
     * `sinceSeq` while `truncated` is `true` to walk the whole log.
     */
    getSince: (sinceSeq: number, limit?: number) => Promise<{ cursor?: number; entries: EventLogEntry[]; truncated: boolean }>;

    /** Return the total number of entries currently in the log. */
    getSize: () => Promise<number>;

    /** Return the full log state — all entries plus the next seq number. */
    getState: () => Promise<{ entries: EventLogEntry[]; nextSeq: number }>;
}

/**
 * The context shape produced by {@link eventsContext}.
 * @experimental
 */
export interface EventsContextOutput {
    /** Typed event log facade backed by an {@link EventLogDOClient}. */
    readonly events: EventsFacade;
}

// ── Middleware ─────────────────────────────────────────────────────────

/**
 * Create a middleware that attaches a typed `ctx.events` facade backed by
 * the given {@link EventLogDOClient}.
 *
 * The facade surfaces `append`, `getSince`, `getSize`, and
 * `getState` — every method the DO client exposes — so handlers can read
 * and write the event log without reaching for the DO stub directly.
 *
 * The middleware is unopinionated about which context it extends — it works
 * with `MutationCtx`, `ActionCtx`, or `QueryCtx` equally.
 * @param client A configured {@link EventLogDOClient} instance.
 * @returns A Lunora middleware that injects `ctx.events`.
 *
 * ```ts
 * const client = new EventLogDOClient({
 * fetch: (req) => env.EVENTS.get(id).fetch(req),
 * });
 *
 * export const logEvent = mutation
 * .use(eventsContext(client))
 * .mutation(async ({ ctx, args }) => {
 * const [entry] = await ctx.events.append([{ type: "order.placed", payload: args }]);
 * return entry;
 * });
 * ```
 * @experimental
 */
export const eventsContext = <Context>(client: EventLogDOClient): Middleware<Context, Context & EventsContextOutput> => {
    const facade: EventsFacade = client;

    return async ({ ctx: _context, next }) => next({ ctx: { events: facade } });
};
