import type { CirrusAuth, CirrusAuthOptions } from "@cirrus/auth";
import { cirrusD1Adapter, createAuth, createAuthAdmin, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import { admin, passkey, twoFactor } from "@cirrus/auth/plugins";
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@cirrus/d1";
import { createD1CtxDb, listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import { createMailerFromEnv } from "@cirrus/mail";
import type { PaymentsFromContextOptions, StripeClientLike } from "@cirrus/payment";
import { createStripeAdapter } from "@cirrus/payment";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
// eslint-disable-next-line import/no-named-as-default -- `stripe`'s default export is the `Stripe` class; this is its documented import form
import Stripe from "stripe";

import { CIRRUS_CRONS } from "../cirrus/_generated/crons.js";
import { CIRRUS_FUNCTIONS } from "../cirrus/_generated/functions.js";
import { openApiSpec } from "../cirrus/_generated/openapi.js";
import { createShardDO } from "../cirrus/_generated/shard.js";
import schema from "../cirrus/schema.js";
import { CIRRUS_CLOUD_PLANS } from "./billing/plans";
import { createDeployRouter } from "./deploy/router";

/**
 * Cirrus Cloud control-plane Worker — the platform itself, dogfooded on Cirrus
 * (see CLOUD-PLAN.md). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

/** Adapt the raw D1 binding to `@cirrus/d1`'s `D1Exec`. */
const buildExec = (database: D1DatabaseLike): D1Exec => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};

/** Let the studio's global data browser list/page the `.global()` (D1) tables. */
const d1Introspector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

interface ShardEnv {
    DB?: D1DatabaseLike;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * Build the `@cirrus/payment` config for a shard request (CLOUD-PLAN.md §4).
 * The org id is the payment `referenceId`; the store rides `ctx.db` (the
 * `.global()` payment tables in the control-plane D1). The provider adapter is
 * always wired so entitlement reads work offline — only live Stripe calls
 * (checkout/portal/webhook) need a real `STRIPE_SECRET_KEY`. Membership is
 * gated by the `cirrus/billing.ts` functions (which `assertMember` before
 * touching `ctx.payments`), so the per-caller `authorize` here is allow-all.
 */
const paymentConfig = (env: ShardEnv): PaymentsFromContextOptions => {
    return {
        adapter: createStripeAdapter({
            // A real `Stripe` instance satisfies the structural client; the cast keeps
            // the package free of a hard `stripe` type dependency. A placeholder key
            // keeps construction from throwing when billing isn't configured — live
            // calls then fail with a clear Stripe auth error.
            client: new Stripe(env.STRIPE_SECRET_KEY ?? "sk_unconfigured", { httpClient: Stripe.createFetchHttpClient() }) as unknown as StripeClientLike,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
        }),
        authorize: () => true,
        entitlements: CIRRUS_CLOUD_PLANS,
        observability: (event) => {
            // eslint-disable-next-line no-console -- route billing telemetry to logs/metrics/alerts
            console.log("[payment]", event.type, event);
        },
    };
};

/**
 * The control-plane shard DO. `.global()` tables (`cells`, `organizations`)
 * route through the D1 ctx-db; org-scoped tables (`projects`, `deployments`, …)
 * stay in the per-org shard's SQLite. `payment` assembles `ctx.payments` per
 * request for the billing functions.
 */
export const ShardDO = createShardDO({
    d1: (env) => {
        const shardEnv = env as ShardEnv;

        if (!shardEnv.DB) {
            return undefined;
        }

        return createD1CtxDb({
            exec: buildExec(shardEnv.DB),
            schema: schema as unknown as D1CtxDbOptions["schema"],
        });
    },
    payment: (env) => paymentConfig(env),
});

interface Env {
    /** Secret backing the studio's better-auth sessions. */
    AUTH_SECRET?: string;
    /** Base URL better-auth resolves callbacks against. */
    AUTH_URL?: string;
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    CIRRUS_ADMIN_TOKEN?: string;
    /** Control-plane D1 — backs the `.global()` cells/organizations tables + auth. */
    DB: unknown;
    /** Optional GitHub OAuth app for studio social sign-in. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Optional Google OAuth app for studio social sign-in. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Sender address for auth (verification / reset) email; captured in dev. */
    MAIL_FROM?: string;
    SHARD: ShardNamespaceLike;
    /** Stripe billing secrets (§4). Absent → billing reads work, live calls fail. */
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
}

/** Build the OAuth provider map from env — only providers with creds are enabled. */
const socialProviders = (env: Env): CirrusAuthOptions["socialProviders"] => {
    const providers: NonNullable<CirrusAuthOptions["socialProviders"]> = {};

    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
    }

    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    }

    return Object.keys(providers).length > 0 ? providers : undefined;
};

let worker: ReturnType<typeof createWorker> | null = null;
let auth: CirrusAuth | null = null;

// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its per-cell scheduler persists across requests.
const deployRouter = createDeployRouter();

/**
 * Better-auth config backing the hosted studio (§3). Hardened beyond bare
 * email/password: password-reset + email-verification mail route through
 * `@cirrus/mail` (captured into the studio Mail tab in dev), optional GitHub/
 * Google OAuth when configured, better-auth's built-in request rate limiting,
 * and the `admin` (user management) / `twoFactor` / `passkey` plugins the
 * studio's auth dashboard adapts to. Org membership stays the Cirrus
 * `organizations`/`members` model — the better-auth `organization` plugin is
 * deliberately omitted to avoid two parallel org models.
 */
const authOptions = (env: Env): CirrusAuthOptions => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    // Built lazily inside each callback (not here): `createMailerFromEnv` throws
    // when no transport is configured (e.g. prod without MAIL_FROM), and we don't
    // want that to take down auth — only the individual email send.
    const mailer = (): ReturnType<typeof createMailerFromEnv> => createMailerFromEnv(env as unknown as Record<string, unknown>);

    return {
        baseURL: env.AUTH_URL,
        emailAndPassword: {
            enabled: true,
            // Mail the reset link; in dev it's captured into the studio Mail tab.
            sendResetPassword: async ({ url, user }) => {
                await mailer().send({ subject: "Reset your Cirrus Cloud password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ url, user }) => {
                await mailer().send({ subject: "Verify your Cirrus Cloud email", text: `Verify your email:\n${url}`, to: user.email });
            },
        },
        plugins: [admin({ defaultRole: "user" }), twoFactor(), passkey()],
        // Built-in per-IP throttling on the auth endpoints (sign-in/up, reset).
        rateLimit: { enabled: true },
        secret: env.AUTH_SECRET,
        socialProviders: socialProviders(env),
    };
};

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        adminToken: env.CIRRUS_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio SPA + the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (cirrus/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: CIRRUS_CRONS,
        d1: env.DB,
        functions: CIRRUS_FUNCTIONS,
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        httpRouter: deployRouter,
        openApiSpec,
        resolveIdentity: async (request) => {
            if (!auth) {
                return null;
            }

            const session = await auth.api.getSession({ headers: request.headers });

            return session?.user?.id ? { userId: session.user.id } : null;
        },
        routes: {},
        shardDO: env.SHARD,
    });

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        if (!auth) {
            // Runtime auth instance uses the SQL adapter; a throwaway instance on
            // the raw D1 drives the one-time schema migration (better-auth Kysely).
            auth = createAuth({ ...authOptions(env), database: cirrusD1Adapter(env.DB as never) });
            await ensureMigrated(createAuth({ ...authOptions(env), database: env.DB as never }));
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        await worker.scheduled(controller, env, context);
    },
};
