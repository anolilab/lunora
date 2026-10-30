/**
 * The app's shared procedure builders — the `crpc`-style module most real apps
 * grow: one place that decides what "signed in", "in an organisation", "may
 * write" and "rate limited" mean, so every domain module builds on it instead of
 * repeating the checks.
 *
 * It is also deliberately the shape of the app behind issue #1166: this module
 * imports the rate limiter and zod at value level, and every function module
 * imports this module. Whatever this file reaches is evaluated at Worker startup
 * no matter how the function registry is loaded, which is what `apps/bench`
 * measures. (better-auth is on that path too, through `.auth()` in `server.ts`.)
 */
import { LunoraError } from "@lunora/errors";
import type { RateLimitConfigMap } from "lunorash/ratelimit";
import { createDbStore, rateLimit, RateLimiter } from "lunorash/ratelimit";
import type { Middleware, Policy } from "lunorash/server";
import { definePolicies, rls } from "lunorash/server";
import * as z from "zod";

import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "../_generated/server.js";
import { action, mutation, query, v } from "../_generated/server.js";

/** Write limits every org-scoped mutation draws from; the bucket table is the one the `ratelimit` item declares. */
export const appLimits = {
    bulk: { kind: "fixed window", period: 60_000, rate: 5 },
    read: { kind: "sliding window", period: 10_000, rate: 200 },
    write: { capacity: 60, kind: "token bucket", period: 60_000, rate: 30 },
} as const satisfies RateLimitConfigMap;

export type AppLimit = keyof typeof appLimits;

const makeLimiter = (database: unknown): RateLimiter<AppLimit> =>
    new RateLimiter<AppLimit>({ config: appLimits, store: createDbStore({ db: database as never, table: "ratelimit_buckets" }) });

// One resolver per context type: `rateLimit` infers its context from these, and a
// shared `{ db: unknown }` parameter would pin every downstream handler's ctx to it.
const queryLimiter = (ctx: QueryContext): RateLimiter<AppLimit> => makeLimiter(ctx.db);
const mutationLimiter = (ctx: MutationContext): RateLimiter<AppLimit> => makeLimiter(ctx.db);

/** Keyed on the server-trusted caller, never on `args`: an argument-derived key is rotated per request. */
const byCaller = (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon";

const WRITER_ROLES = new Set(["admin", "owner"]);

const hasRole = (value: unknown, allowed: ReadonlySet<string>): boolean =>
    typeof value === "string" && value.split(",").some((role) => allowed.has(role.trim()));

export interface OrgCaller {
    organizationId: string;
    orgRole?: string;
    userId: string;
}

/** The caller's tenant from the verified identity claim — never from an argument. */
export const requireOrg = async (ctx: Pick<QueryContext, "auth">): Promise<OrgCaller> => {
    const { userId } = ctx.auth;

    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const identity: Record<string, unknown> = (await ctx.auth.getIdentity()) ?? {};
    const organizationId = identity["activeOrganizationId"];

    if (typeof organizationId !== "string" || organizationId === "") {
        throw new LunoraError("UNPROCESSABLE", "no active organization");
    }

    return { organizationId, orgRole: typeof identity["orgRole"] === "string" ? identity["orgRole"] : undefined, userId };
};

export const requireWriter = async (ctx: Pick<MutationContext, "auth">): Promise<OrgCaller> => {
    const caller = await requireOrg(ctx);

    if (!hasRole(caller.orgRole, WRITER_ROLES)) {
        throw new LunoraError("FORBIDDEN", "requires the admin or owner role in this organization");
    }

    return caller;
};

/**
 * The standard tenant policy set for a `.shardBy("organizationId")` table: a
 * caller reads and writes rows of their active organisation only. The shard
 * already isolates tenants physically; the policy is what stops a misrouted call
 * (a `shardKey` that names the wrong tenant) from reading the shard it landed on.
 */
export const tenantPolicies = (table: string): ReadonlyArray<Policy> => {
    const sameTenant = ({ auth }: { auth: { identity?: Record<string, unknown> | null } }) => {
        return {
            // A caller with no organisation matches no row: "∅" is never an organisation id.
            organizationId: typeof auth.identity?.["activeOrganizationId"] === "string" ? auth.identity["activeOrganizationId"] : "∅",
        };
    };
    const ownsRow = ({ auth, row }: { auth: { identity?: Record<string, unknown> | null }; row?: Record<string, unknown> | null }) =>
        row?.["organizationId"] === auth.identity?.["activeOrganizationId"];

    return definePolicies([
        { on: "read", table, when: sameTenant },
        { on: "insert", table, when: ownsRow },
        { on: "update", table, when: ownsRow },
        { on: "delete", table, when: ownsRow },
    ] as Policy[]);
};

/** Signed-in reads, any shard. */
export const authedQuery = query.use(async ({ ctx, next }) => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return next({ ctx: { ...ctx } });
});

/** Org-scoped reads: read budget per caller, tenant RLS chained per table with {@link tenantRead}. */
export const orgQuery = authedQuery.use(rateLimit(queryLimiter, "read", { key: byCaller }));

/** Org-scoped writes: write budget per caller. */
export const orgMutation = mutation.use(rateLimit(mutationLimiter, "write", { key: byCaller }));

/** Org-scoped bulk writes (imports, mass updates): a much smaller budget. */
export const orgBulkMutation = mutation.use(rateLimit(mutationLimiter, "bulk", { key: byCaller }));

const tenantRls = (tables: string[]) => rls(definePolicies(tables.flatMap((table) => tenantPolicies(table))));

/*
 * `rls()` types its context against the runtime writer shape, which the generated
 * `QueryCtx` / `MutationCtx` do not structurally satisfy (see FINDINGS.md), so the
 * two tenant guards are cast once here, the way `examples/clerk-auth` does.
 */

/** Tenant RLS over the given tables, for a query. */
export const tenantRead = (...tables: string[]): Middleware<QueryContext, QueryContext> =>
    tenantRls(tables) as unknown as Middleware<QueryContext, QueryContext>;

/** Tenant RLS over the given tables, for a mutation. */
export const tenantWrite = (...tables: string[]): Middleware<MutationContext, MutationContext> =>
    tenantRls(tables) as unknown as Middleware<MutationContext, MutationContext>;

/** Signed-in actions. */
export const authAction = action.use(async ({ ctx, next }) => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return next({ ctx: { ...ctx } });
});

/** Shared zod shapes; `v.from(...)` turns one into an args validator. */
export const slugSchema = z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/u);
export const emailSchema = z.email().max(254);
export const tagsSchema = z.array(z.string().min(1).max(32)).max(20);
export const moneySchema = z.object({ amount: z.int().nonnegative(), currency: z.string().length(3) });
export const dateRangeSchema = z.object({ from: z.int(), to: z.int() }).refine((range) => range.from <= range.to, { error: "from must not be after to" });

export const pageArgs = { cursor: v.optional(v.string()), limit: v.optional(v.number().int().min(1).max(200)) };

export { internalMutation, v } from "../_generated/server.js";
