import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
import { createAuth, createAuthAdmin, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";
import { admin, passkey, twoFactor } from "@lunora/auth/plugins";
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";
import { createD1CtxDb, facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "@lunora/d1";
import { createMailerFromEnv } from "@lunora/mail";
import type { PaymentsFromContextOptions, StripeClientLike } from "@lunora/payment";
import { createStripeAdapter } from "@lunora/payment";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
// eslint-disable-next-line import/no-named-as-default -- `stripe`'s default export is the `Stripe` class; this is its documented import form
import Stripe from "stripe";

import { LUNORA_CRONS } from "../lunora/_generated/crons.js";
import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import { createShardDO } from "../lunora/_generated/shard.js";
import schema from "../lunora/schema.js";
import { LUNORA_CLOUD_PLANS } from "./billing/plans";
import { createDeployRouter } from "./deploy/router";
import type { CronTarget } from "./fanout/cron";
import { fanOutCron } from "./fanout/cron";
import type { QueueMessage, TenantQueueGroup } from "./fanout/queue";
import { fanOutQueue, groupByTenant } from "./fanout/queue";

/**
 * Lunora Cloud control-plane Worker — the platform itself, dogfooded on Lunora
 * (see CLOUD-PLAN.md). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

/** Adapt the raw D1 binding to `@lunora/d1`'s `D1Exec`. */
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
        facetColumn: (options) => facetGlobalColumn(exec, schema as never, options),
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
 * Build the `@lunora/payment` config for a shard request (CLOUD-PLAN.md §4).
 * The org id is the payment `referenceId`; the store rides `ctx.db` (the
 * `.global()` payment tables in the control-plane D1). The provider adapter is
 * always wired so entitlement reads work offline — only live Stripe calls
 * (checkout/portal/webhook) need a real `STRIPE_SECRET_KEY`. Membership is
 * gated by the `lunora/billing.ts` functions (which `assertMember` before
 * touching `ctx.payments`), so the per-caller `authorize` here is allow-all.
 */
// Memoized per isolate: the Stripe client + adapter are pure functions of env
// (stable within an isolate), so build them once instead of on every shard
// request that touches `ctx.payments`.
let cachedPayment: { config: PaymentsFromContextOptions; key: string } | null = null;

const paymentConfig = (env: ShardEnv): PaymentsFromContextOptions => {
    const key = `${env.STRIPE_SECRET_KEY ?? ""}|${env.STRIPE_WEBHOOK_SECRET ?? ""}`;

    if (cachedPayment?.key !== key) {
        cachedPayment = {
            config: {
                adapter: createStripeAdapter({
                    // A real `Stripe` instance satisfies the structural client; the cast
                    // keeps the package free of a hard `stripe` type dependency. A
                    // placeholder key keeps construction from throwing when billing isn't
                    // configured — live calls then fail with a clear Stripe auth error.
                    client: new Stripe(env.STRIPE_SECRET_KEY ?? "sk_unconfigured", {
                        httpClient: Stripe.createFetchHttpClient(),
                    }) as unknown as StripeClientLike,
                    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
                }),
                authorize: () => true,
                entitlements: LUNORA_CLOUD_PLANS,
                observability: (event) => {
                    // eslint-disable-next-line no-console -- route billing telemetry to logs/metrics/alerts
                    console.log("[payment]", event.type, event);
                },
            },
            key,
        };
    }

    return cachedPayment.config;
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
    /** Control-plane D1 — backs the `.global()` cells/organizations tables + auth. */
    DB: unknown;
    /** Dispatch namespace — used by the cron fan-out to tick tenants (§2.4). */
    DISPATCHER?: { get: (scriptName: string) => { fetch: (request: Request) => Promise<Response> } };
    /** Optional GitHub OAuth app for studio social sign-in. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Optional Google OAuth app for studio social sign-in. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    LUNORA_ADMIN_TOKEN?: string;
    /** Sender address for auth (verification / reset) email; captured in dev. */
    MAIL_FROM?: string;
    SHARD: ShardNamespaceLike;
    /** Stripe billing secrets (§4). Absent → billing reads work, live calls fail. */
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
}

/** Build the OAuth provider map from env — only providers with creds are enabled. */
const socialProviders = (env: Env): LunoraAuthOptions["socialProviders"] => {
    const providers: NonNullable<LunoraAuthOptions["socialProviders"]> = {};

    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
    }

    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    }

    return Object.keys(providers).length > 0 ? providers : undefined;
};

let worker: ReturnType<typeof createWorker> | null = null;
let auth: LunoraAuth | null = null;

// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its per-cell scheduler persists across requests.
const deployRouter = createDeployRouter();

// The control plane runs an every-minute trigger; tenant crons are matched to it
// by due-evaluation in the fan-out (§2.4). Its own code crons still fire on their
// own declared expressions (both are in wrangler.jsonc `triggers.crons`).
// Matches the `*/1 * * * *` expression `crons.interval({ minutes: 1 })` compiles
// to (the "tenant cron fan-out tick" heartbeat in lunora/crons.ts).
const EVERY_MINUTE = "*/1 * * * *";

interface LiveDeploymentRow {
    adminToken?: string;
    cronSpecs?: string[];
    scriptName: string;
}

/** Read the live deployments (admin tokens stay in-process, never exposed over an endpoint). */
const readLiveDeployments = async (env: Env): Promise<LiveDeploymentRow[]> => {
    if (!env.DB) {
        return [];
    }

    const database = createD1CtxDb({ exec: buildExec(env.DB as D1DatabaseLike), schema: schema as unknown as D1CtxDbOptions["schema"] });
    const { page } = await database.findMany("deployments", { where: { status: "live" } });

    return page as unknown as LiveDeploymentRow[];
};

/** Live deployments that declare cron expressions, shaped for the cron fan-out. */
const readCronTargets = async (env: Env): Promise<CronTarget[]> => {
    const live = await readLiveDeployments(env);

    return live
        .filter(
            (row): row is LiveDeploymentRow & { adminToken: string; cronSpecs: string[] } =>
                Boolean(row.adminToken) && Array.isArray(row.cronSpecs) && row.cronSpecs.length > 0,
        )
        .map((row) => {
            return { adminToken: row.adminToken, cronSpecs: row.cronSpecs, scriptName: row.scriptName };
        });
};

/** Script id → per-deployment admin token, for the queue fan-out. */
const readDeploymentTokens = async (env: Env): Promise<Map<string, string>> => {
    const tokens = new Map<string, string>();

    for (const row of await readLiveDeployments(env)) {
        if (row.adminToken) {
            tokens.set(row.scriptName, row.adminToken);
        }
    }

    return tokens;
};

/** Tick one tenant's cron over the dispatcher, gated by its admin token. */
const dispatchCronTick = async (
    dispatcher: NonNullable<Env["DISPATCHER"]>,
    tick: { adminToken: string; cron: string; scriptName: string },
): Promise<boolean> => {
    const response = await dispatcher.get(tick.scriptName).fetch(
        new Request("https://tenant.internal/_lunora/scheduled", {
            body: JSON.stringify({ cron: tick.cron }),
            headers: { authorization: `Bearer ${tick.adminToken}`, "content-type": "application/json" },
            method: "POST",
        }),
    );

    return response.ok;
};

/**
 * Forward one tenant's queue sub-batch to its `/_lunora/queue` endpoint, gated by
 * its admin token. Returns the message ids the tenant asked to retry; on a
 * delivery failure the whole group is retried (the caller catches the throw).
 */
const dispatchQueueBatch = async (dispatcher: NonNullable<Env["DISPATCHER"]>, group: TenantQueueGroup, adminToken: string): Promise<string[]> => {
    const response = await dispatcher.get(group.script).fetch(
        new Request("https://tenant.internal/_lunora/queue", {
            body: JSON.stringify({ messages: group.messages, queue: "tenant" }),
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
            method: "POST",
        }),
    );

    if (!response.ok) {
        throw new Error(`queue forward failed: ${String(response.status)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
    const result = (await response.json()) as { retry?: unknown };
    const retry: unknown[] = Array.isArray(result.retry) ? result.retry : [];

    return retry.filter((id): id is string => typeof id === "string");
};

/** A queue batch the platform consumer drains (Cloudflare `MessageBatch`, minimally typed). */
interface QueueBatchLike {
    messages: ReadonlyArray<QueueMessage & { ack: () => void; retry: () => void }>;
    queue: string;
}

/**
 * The platform-owned queue consumer (§2.4). WfP tenants can't be queue
 * consumers, so this account-level handler drains the shared queue, groups by
 * the producing tenant's script, and forwards each sub-batch to that tenant's
 * `/_lunora/queue` (admin tokens resolved in-process). Per the tenant's reply
 * (or a delivery failure) it retries only the failed messages.
 */
const handleQueueBatch = async (batch: QueueBatchLike, env: Env): Promise<void> => {
    if (!env.DISPATCHER) {
        batch.messages.forEach((message) => {
            message.retry();
        });

        return;
    }

    const dispatcher = env.DISPATCHER;
    const tokens = await readDeploymentTokens(env);
    const { groups, unrouted } = groupByTenant(
        batch.messages.map((message) => {
            return { body: message.body, id: message.id };
        }),
    );
    const unroutedSet = new Set(unrouted);

    // A group whose tenant has no live deployment (or token) can't be delivered;
    // treat its ids as unrouted (ack — retrying would loop) rather than retry.
    const deliverable = groups.filter((group) => tokens.has(group.script));

    for (const group of groups) {
        if (!tokens.has(group.script)) {
            for (const message of group.messages) {
                unroutedSet.add(message.id);
            }
        }
    }

    const { retry } = await fanOutQueue({
        dispatch: (group) => dispatchQueueBatch(dispatcher, group, tokens.get(group.script) as string),
        groups: deliverable,
    });

    for (const message of batch.messages) {
        if (retry.has(message.id) && !unroutedSet.has(message.id)) {
            message.retry();
        } else {
            message.ack();
        }
    }
};

/**
 * Better-auth config backing the hosted studio (§3). Hardened beyond bare
 * email/password: password-reset + email-verification mail route through
 * `@lunora/mail` (captured into the studio Mail tab in dev), optional GitHub/
 * Google OAuth when configured, better-auth's built-in request rate limiting,
 * and the `admin` (user management) / `twoFactor` / `passkey` plugins the
 * studio's auth dashboard adapts to. Org membership stays the Lunora
 * `organizations`/`members` model — the better-auth `organization` plugin is
 * deliberately omitted to avoid two parallel org models.
 */
const authOptions = (env: Env): LunoraAuthOptions => {
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
                await mailer().send({ subject: "Reset your Lunora Cloud password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ url, user }) => {
                await mailer().send({ subject: "Verify your Lunora Cloud email", text: `Verify your email:\n${url}`, to: user.email });
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
        adminToken: env.LUNORA_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio SPA + the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (lunora/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: LUNORA_CRONS,
        d1: env.DB,
        functions: LUNORA_FUNCTIONS,
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
            auth = createAuth({ ...authOptions(env), database: lunoraD1Adapter(env.DB as never) });
            await ensureMigrated(createAuth({ ...authOptions(env), database: env.DB as never }));
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async queue(batch: QueueBatchLike, env: Env): Promise<void> {
        // Platform-owned queue consumer for namespaced tenants (§2.4).
        await handleQueueBatch(batch, env);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        // The control plane's own code crons fire on their declared expression.
        await worker.scheduled(controller, env, context);

        // Tenant cron fan-out (§2.4): the every-minute trigger ticks each tenant
        // whose cron is due. WfP drops `triggers.crons` for namespaced workers, so
        // this is the only path that fires their cron jobs.
        if (controller.cron === EVERY_MINUTE && env.DISPATCHER) {
            const dispatcher = env.DISPATCHER;
            const targets = await readCronTargets(env);

            await fanOutCron({
                dispatch: (tick) => dispatchCronTick(dispatcher, tick),
                now: new Date(),
                targets,
            });
        }
    },
};
