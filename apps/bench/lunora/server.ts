import { launch } from "@cloudflare/playwright";
import type { BrowserBindingLike } from "@lunora/browser";
import { createBrowser } from "@lunora/browser";
import type { D1DatabaseLike } from "@lunora/d1";
import { LunoraError } from "@lunora/errors";
import type { HyperdriveLike } from "@lunora/hyperdrive";
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import { createFunctionMcpServer, serveStateless } from "@lunora/mcp/worker";
import type { EntitlementsConfig, PaymentAdapter } from "@lunora/payment";
import { createStripeAdapter } from "@lunora/payment/stripe";
import type { DurableObjectNamespaceLike } from "@lunora/scheduler";
import type { R2BucketLike } from "@lunora/storage";
import { createProcedureChargeGate } from "@lunora/x402/charge";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { consoleSink, otlpSink } from "lunorash/runtime";
import postgres from "postgres";
import { Stripe } from "stripe";

import { defineApp } from "./_generated/app.js";
import { openRpcSpec } from "./_generated/openrpc.js";
import { authOptions, getAuth } from "./auth/index.js";
import http from "./http.js";
import { entitlementsFromPlans, PLANS } from "./plans.js";

interface Env extends Record<string, unknown> {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL?: string;
    /** Browser Rendering; remote-only, so `web.preview` fails in local dev while everything else runs. */
    BROWSER: BrowserBindingLike;
    // Typed rather than `unknown`: `.global(...)` takes the binding itself, so an
    // untyped `DB` is a TS2322 at the chain rather than a cast inside it.
    DB: D1DatabaseLike;
    HYPERDRIVE: HyperdriveLike;
    /** Bearer for `/_lunora/admin/*` (the studio) and the workflow / scheduler callbacks. */
    LUNORA_ADMIN_TOKEN?: string;
    /** The worker's own origin; the SchedulerDO dispatches jobs back to it (read off its own env, never a request). */
    LUNORA_ORIGIN_URL?: string;
    /** Set both to export logs, traces and metrics over OTLP; unset, they go to the console. */
    LUNORA_OTLP_ENDPOINT?: string;
    LUNORA_OTLP_TOKEN?: string;
    SCHEDULER: DurableObjectNamespaceLike & ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    SHARD_REGISTRY: ShardNamespaceLike;
    STORAGE_SIGNING_SECRET?: string;
    // Optional: an app that has not wired billing yet still serves every other
    // function. Only a payment call needs them — see `stripeAdapter`.
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    UPLOADS: R2BucketLike;
    /** The EVM address paid `.x402()` procedures settle to; unset, the charge gate is off and paid procedures refuse. */
    X402_PAYOUT_ADDRESS?: `0x${string}`;
}

/** One sink for both halves (the shard's `ctx.log`/`ctx.trace`/`ctx.metrics`, and the worker's per-RPC events). */
const telemetry = (env: Env) =>
    env.LUNORA_OTLP_ENDPOINT ? otlpSink({ endpoint: env.LUNORA_OTLP_ENDPOINT, token: env.LUNORA_OTLP_TOKEN ?? "" }) : consoleSink();

const BEARER = /^Bearer\s+/iu;

/**
 * MCP over HTTP: one tool per public function, run as the caller's own bearer
 * through the public RPC path, so auth and RLS apply as in the app. Read-only.
 */
const serveMcp = async (request: Request, env: Env): Promise<Response> => {
    const token = request.headers.get("authorization")?.replace(BEARER, "");

    if (!token || !env.LUNORA_ORIGIN_URL) {
        return new Response("unauthorized", { status: 401 });
    }

    return serveStateless(createFunctionMcpServer({ allowWrites: false, openRpcSpec, token, url: env.LUNORA_ORIGIN_URL }), request);
};

/**
 * Plan ids → what they unlock, for `ctx.payments.check` — derived from the one
 * catalog the pricing page also renders (`lunora/plans.ts`), so the two cannot
 * disagree. The free plan has no price, so it grants nothing here: a tenant
 * with no subscription is on it by definition.
 *
 * `lunora/payment/index.ts` checks `api_calls` against the per-plan allowance in
 * the catalog. The other features are not called by the kit; gate one where it is
 * served, from an action on the root shard (the billing tables live there), e.g.
 * `(await ctx.payments.check({ featureId: "export", referenceId: organizationId })).allowed`.
 */
const ENTITLEMENTS: EntitlementsConfig = entitlementsFromPlans(PLANS);

/**
 * The Stripe adapter, built once per isolate.
 *
 * The runtime calls the `.payment()` factory for every function context, not
 * just the ones that touch `ctx.payments`, so constructing `new Stripe(key)`
 * there made EVERY call — `saas.overview` included — throw when the key was
 * unset. The adapter only reaches its client inside a method, so the client is
 * resolved on first use instead, and a missing key fails that payment call with
 * a message that says what to set.
 */
let stripeAdapter: PaymentAdapter | undefined;
let stripe: Stripe | undefined;

const stripeClient = (env: Env): Stripe => {
    if (!env.STRIPE_SECRET_KEY) {
        throw new LunoraError("NOT_IMPLEMENTED", "payments are not configured — set STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) in .dev.vars or as a secret");
    }

    // `stripe` is an optional peer dependency; the fetch HTTP client is required
    // on workerd.
    stripe ??= new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

    return stripe;
};

const paymentAdapter = (env: Env): PaymentAdapter => {
    stripeAdapter ??= createStripeAdapter({
        client: {
            get billing() {
                return stripeClient(env).billing;
            },
            get billingPortal() {
                return stripeClient(env).billingPortal;
            },
            get checkout() {
                return stripeClient(env).checkout;
            },
            get customers() {
                return stripeClient(env).customers;
            },
            get paymentIntents() {
                return stripeClient(env).paymentIntents;
            },
            get refunds() {
                return stripeClient(env).refunds;
            },
            get subscriptionItems() {
                return stripeClient(env).subscriptionItems;
            },
            get subscriptions() {
                return stripeClient(env).subscriptions;
            },
            get webhooks() {
                return stripeClient(env).webhooks;
            },
        },
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    });

    return stripeAdapter;
};

/**
 * The resolved identity: the claims `lunora/identity.ts` declares, plus the
 * undeclared ones the runtime and `saas.me` read (`name`, `expiresAtMs`).
 */
const resolveIdentity = async (env: Env, request: Request): Promise<{ [claim: string]: unknown; userId: string } | null> => {
    const auth = getAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user.id) {
        return null;
    }

    /*
     * `organization()` and `admin()` add `activeOrganizationId` and `role` at
     * runtime, but `createAuth` is declared to return the erased `LunoraAuth`,
     * so better-auth's plugin inference never reaches a consumer. Reading them
     * through one narrow shape at this single boundary is the containment: the
     * claims are validated against `lunora/identity.ts` immediately afterwards,
     * and a claim set that does not match is rejected with a 401.
     */
    const { activeOrganizationId } = session.session as { activeOrganizationId?: string | null };
    const { role } = session.user as { role?: string | null };

    /*
     * The caller's role in the organisation is NOT on the session — it lives on
     * better-auth's `member` row. The same lookup is the membership check: a
     * session can still name an organisation its user has been removed from,
     * and that must not become a tenant claim (it is what `authorizeShard`
     * admits the caller to).
     */
    const { adapter } = await auth.$context;
    const member = activeOrganizationId
        ? await adapter.findOne<{ role: string }>({
              model: "member",
              where: [
                  { field: "organizationId", value: activeOrganizationId },
                  { field: "userId", value: session.user.id },
              ],
          })
        : null;
    const { expiresAt } = session.session;

    return {
        activeOrganizationId: member ? activeOrganizationId : undefined,
        appRole: role ?? undefined,
        // The socket credential expiry: without it a signed-out user keeps an
        // already-open WebSocket streaming their tenant's rows.
        ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
        name: session.user.name || undefined,
        orgRole: member?.role,
        userId: session.user.id,
    };
};

/**
 * The worker, and the two callbacks that make tenant-per-shard real.
 *
 * `resolveIdentity` turns the better-auth session into the claim set declared in
 * `lunora/identity.ts`. The runtime validates it against that contract before it
 * becomes `ctx.auth`, and `onInvalid: "reject"` means a malformed claim set
 * fails closed with a 401 rather than arriving as an anonymous caller.
 *
 * `authorizeShard` is the boundary itself. Every sharded table in this app is
 * `.shardBy("organizationId")`, so the shard key IS the tenant id — a caller may
 * enter their active organisation's shard and no other. The client names the
 * shard (`{ shardKey: organizationId }`, read from `api.saas.me`); this is what
 * stops it naming someone else's.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Tracks which shards hold `.shardBy()` rows, for cross-shard export, CDC sync and migrations.
    .shardRegistry((env) => env.SHARD_REGISTRY)
    // `ctx.scheduler` (delayed jobs, `lunora/crons.ts`) and the studio's scheduled-jobs view.
    .scheduler({ namespace: (env) => env.SCHEDULER })
    .admin((env) => env.LUNORA_ADMIN_TOKEN)
    .storage({ bucket: (env) => env.UPLOADS, signingSecret: (env) => env.STORAGE_SIGNING_SECRET })
    .observability((env) => telemetry(env as Env))
    // `ctx.sql` (actions only). Local dev runs on embedded PGlite; the connection is opened per call.
    .hyperdrive((env) => fromPostgresJs(postgres(createHyperdrive(env.HYPERDRIVE).connectionString)))
    .browser((env) => createBrowser({ allowedHosts: ["github.com", "docs.github.com", "developers.cloudflare.com"], binding: env.BROWSER, launch }))
    .route("/mcp", async (request, env) => serveMcp(request, env as Env))
    // The D1 writer behind the `.global()` `saas_organizations` table. Omit it and
    // the shard has no global backend, so every admin list and every slug lookup
    // throws INTERNAL ("requires a globalDb writer") at runtime — with types that
    // compiled fine. `DB` is the binding the `auth` item already declares.
    .global({ d1: (env) => env.DB })
    // better-auth over the same D1: builds the instance, migrates on first
    // request, and serves `/api/auth/*`. Its default resolver carries `userId`
    // only, so `.extend()` below replaces it with the tenant-aware one.
    .auth({ d1: (env) => env.DB, options: authOptions })
    .payment((env) => {
        return {
            adapter: paymentAdapter(env),
            /*
             * The default authorizer admits a reference only when it equals the
             * caller's user id — right for a single-player app, and a FORBIDDEN on
             * every call here, where the reference is the ORGANISATION. The tenant
             * check lives where `ctx.auth` does: the functions in
             * `lunora/payment/index.ts` derive `referenceId` from the caller's
             * verified active organisation and never take it as an argument, and
             * `AuthorizeReference` receives only the id, with no identity to
             * compare it against. So this only refuses a blank reference.
             */
            authorize: (referenceId) => referenceId.trim() !== "",
            entitlements: ENTITLEMENTS,
            /*
             * Failed payments, past-due subscriptions and reconciliation drift
             * arrive here. Route them at your alerting — a dunning failure nobody
             * sees is a cancellation in three weeks' time. The type, provider
             * and tenant only: a `reconcile.error` carries the provider's raw
             * error, which can hold customer details that have no business in
             * Worker logs.
             */
            observability: (event) => {
                // eslint-disable-next-line no-console -- Workers Logs is where this reaches an operator in the kit
                console.log("[payment]", event.type, event.provider, "referenceId" in event ? event.referenceId : undefined);
            },
        };
    })
    .extend((env) => {
        return {
            /**
             * A caller may enter their own tenant's shard, plus the root shard —
             * which holds the billing tables and serves `saas.me`, so every
             * signed-in user needs it. (An unsharded table exists in every shard, so
             * the rate-limit buckets are per organisation: a function running on a
             * tenant's shard counts against that tenant's copy.)
             *
             * Anonymous callers get nothing. The scheduler and queue consumers are
             * exempt from this callback by the runtime (they authenticate first and
             * carry no end-user identity), so an `identity: null` here is always a
             * real anonymous end user.
             *
             * Fan-out is denied by default once this is set, and that is correct for
             * this app: it runs no cross-shard table query. The admin's only
             * cross-tenant read is `saas_organizations`, which is `.global()` and
             * served from D1 — a different path entirely. Add `authorizeFanOut` if
             * you introduce one, and think hard about who may trigger it.
             */
            authorizeShard: ({ identity, shardKey }) => {
                if (!identity?.userId) {
                    return false;
                }

                return shardKey === "__root__" || identity.activeOrganizationId === shardKey;
            },

            observability: telemetry(env),
            resolveIdentity: async (request: Request) => resolveIdentity(env, request),
            // Settles `.x402({ price })` procedures (`lunora/public-api`) on testnet before dispatch.
            x402Charge: env.X402_PAYOUT_ADDRESS
                ? createProcedureChargeGate({ network: "base-sepolia", recipient: { evm: env.X402_PAYOUT_ADDRESS } })
                : undefined,
        };
    })
    // `wrangler.jsonc` points `main` HERE rather than at `virtual:lunora/worker`:
    // the composed virtual entry never imports this file, so the tenancy gate
    // above would be dead.
    .httpRouter(http)
    .build();

export const { ShardDO } = app;
// Workflow entrypoints for `lunora/workflows.ts` and the durable agents in `lunora/agents.ts`.
export * from "./_generated/agents.js";
export { ShardRegistryDO } from "./_generated/shardRegistry.js";
export * from "./_generated/workflows.js";
export { SchedulerDO } from "@lunora/scheduler";
export default app;
