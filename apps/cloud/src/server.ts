import { createAuthAdmin, handleAuthRequest } from "@lunora/auth";
import type { D1CtxDbOptions, D1DatabaseLike } from "@lunora/d1";
import { createD1CtxDb, facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "@lunora/d1";
import type { PaymentsFromContextOptions } from "@lunora/payment";
import { createCreemAdapter } from "@lunora/payment/creem";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
// TanStack Start's server entry default-exports a `{ fetch }` handler — the same
// expression `@lunora/vite`'s class-A composition table emits for this framework.
import ssrHandler from "@tanstack/react-start/server-entry";
import { Creem } from "creem";

import { LUNORA_CRONS } from "../lunora/_generated/crons.js";
import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import { createShardDO } from "../lunora/_generated/shard.js";
import schema from "../lunora/schema.js";
import { currentAuth, ensureAuth } from "./auth";
import { LUNORA_CLOUD_PLANS } from "./billing/plans";
import type { ControlPlaneEnv } from "./control-plane-env";
import { buildExec } from "./d1-store";
import { createDeployRouter } from "./deploy/router";
import type { QueueBatchLike } from "./fanout/platform-queue";
import { handleQueueBatch } from "./fanout/platform-queue";
import { runScheduled } from "./sweeps/scheduled";

/**
 * Lunora Cloud control-plane Worker — the platform itself, dogfooded on Lunora
 * (see `README.md`). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

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
    /** Creem API key (MoR billing, §4). Absent → billing reads work, live calls fail. */
    CREEM_API_KEY?: string;
    /** "true" routes the SDK at Creem's sandbox (test-api.creem.io). */
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    DB?: D1DatabaseLike;
}

/**
 * Build the `@lunora/payment` config for a shard request.
 * The org id is the payment `referenceId`; the store rides `ctx.db` (the
 * `.global()` payment tables in the control-plane D1). The provider adapter is
 * always wired so entitlement reads work offline — only live Creem calls
 * (checkout/portal/webhook) need a real `CREEM_API_KEY`. Creem is a
 * Merchant-of-Record: it is the legal seller and calculates/collects/remits
 * sales tax/VAT globally (the GAPS.md C3 decision). Membership is
 * gated by the `lunora/billing.ts` functions (which `assertMember` before
 * touching `ctx.payments`), so the per-caller `authorize` here is allow-all.
 */
// Memoized per isolate: the Creem client + adapter are pure functions of env
// (stable within an isolate), so build them once instead of on every shard
// request that touches `ctx.payments`.
let cachedPayment: { config: PaymentsFromContextOptions; key: string } | null = null;

const paymentConfig = (env: ShardEnv): PaymentsFromContextOptions => {
    const key = `${env.CREEM_API_KEY ?? ""}|${env.CREEM_WEBHOOK_SECRET ?? ""}|${env.CREEM_TEST_MODE ?? ""}`;

    if (cachedPayment?.key !== key) {
        cachedPayment = {
            config: {
                adapter: createCreemAdapter({
                    // A real `Creem` instance satisfies the structural client; the cast
                    // keeps the app decoupled from the SDK's full types. A placeholder
                    // key keeps construction from throwing when billing isn't
                    // configured — live calls then fail with a clear Creem auth error.
                    client: new Creem({
                        apiKey: env.CREEM_API_KEY ?? "unconfigured",
                        ...(env.CREEM_TEST_MODE === "true" ? { server: "test" as const } : {}),
                    }),
                    webhookSecret: env.CREEM_WEBHOOK_SECRET ?? "",
                }),
                // Always true HERE because the check cannot be expressed here: this
                // config is cached per encryption-key, not per request, so it has no
                // caller identity to authorize against. `@lunora/payment`'s hook
                // exists to stop cross-tenant checkout attachment, and that is
                // enforced one layer up instead — `billing.checkout` calls
                // `assertMember(organizationId, ["owner","admin"])` before passing
                // the org id as `referenceId`, which is framework-controlled and
                // never caller-supplied. Left explicit because an unexplained
                // `() => true` on an authorization hook reads as an oversight.
                authorize: () => true,
                entitlements: LUNORA_CLOUD_PLANS,
                observability: (event) => {
                    // The event TYPE and its correlating ids only — never the payload.
                    // Provider subscription/checkout events carry customer PII (email,
                    // name, billing address, country), and this lands in the Workers log
                    // stream that the tail consumer and any log drain read, with no
                    // redaction pass applied. The ids are what a billing investigation
                    // actually needs; the rest is the provider's dashboard's job.
                    const detail = event as { referenceId?: unknown; subscriptionId?: unknown; type: string };

                    // eslint-disable-next-line no-console -- route billing telemetry to logs/metrics/alerts
                    console.log("[payment]", detail.type, {
                        ...(detail.referenceId === undefined ? {} : { referenceId: detail.referenceId }),
                        ...(detail.subscriptionId === undefined ? {} : { subscriptionId: detail.subscriptionId }),
                    });
                },
            },
            key,
        };
    }

    return cachedPayment.config;
};

/**
 * The build box's Container DO, plus the `ContainerProxy` its egress firewall
 * routes through (GAPS.md A3).
 *
 * Wrangler requires every `containers[].class_name` to be exported by the
 * deployed worker, and codegen warns when one is not — without this the
 * container deploys with nothing to run, and the failure is at build time for
 * a tenant rather than here.
 */
export * from "../lunora/_generated/containers";

/**
 * One per customer box (plan 458 G11): the end of the WebSocket `lunora-hostd`
 * dials out to, and the control plane's only way to reach the box. Bound as
 * `BOX_SESSION`, named by box id; `GET /v1/boxes/connect` forwards the upgrade.
 */
export { BoxSessionDO } from "./boxes/session-do";

/**
 * Deferred-dispatch DO for `@lunora/scheduler`. The control plane's own crons
 * (`lunora/crons.ts`) ride Cloudflare cron triggers and don't need this, but the
 * class must be exported for the `SCHEDULER` binding to be provisionable — so
 * `ctx.scheduler.runAfter` / `runAt` work the first time a function reaches for
 * them, instead of failing at runtime on a missing binding.
 */
export { SchedulerDO } from "@lunora/scheduler";

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

type Env = ControlPlaneEnv;

let worker: ReturnType<typeof createWorker> | null = null;
// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its per-cell scheduler persists across requests.
const deployRouter = createDeployRouter();

/**
 * The `httpRouter` seam, shared by two consumers.
 *
 * `createWorker` treats `httpRouter` as its LOWEST-priority matcher — it runs only
 * after auth (`/api/auth/*`), the explicit routes, and the reserved `/_lunora/*`
 * endpoints have all declined. That is what makes this composition safe: the
 * studio's SSR loaders reach Lunora over `POST /_lunora/rpc` and better-auth over
 * `/api/auth/get-session`, both of which are dispatched ahead of here, so a render
 * can never recurse into itself.
 *
 * `/v1/*` is the machine-facing deploy/telemetry API and keeps its own router —
 * which 404s anything outside `/v1/`, so it cannot be the fallback. Everything
 * else is a browser navigation and belongs to the TanStack Start SSR handler.
 * Ordering, not overlap: the two never contend for a path.
 */
const httpRouter = {
    fetch: async (request: Request, environment?: unknown): Promise<Response> => {
        if (new URL(request.url).pathname.startsWith("/v1/")) {
            return deployRouter.fetch(request, environment);
        }

        // Only the request: TanStack Start's `fetch` takes its OWN options object
        // second (`{ context, onEarlyHints, … }`), not the Cloudflare env. The
        // loaders reach Lunora and better-auth over HTTP, so they need no bindings.
        return ssrHandler.fetch(request);
    },
};

const buildWorker = (env: Env): ReturnType<typeof createWorker> => {
    // Non-null by construction: `fetch` awaits `ensureAuth` before it ever calls
    // this, and `scheduled`/`queue` reach `buildWorker` only after a request has.
    const auth = currentAuth();

    return createWorker({
        adminToken: env.LUNORA_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio and the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (lunora/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: LUNORA_CRONS,
        functions: LUNORA_FUNCTIONS,
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        httpRouter,
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
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        // Build the auth instance (once per isolate, migration included) before
        // anything dispatches: `buildWorker` below reads it, and so does the
        // invite route in `deploy/router.ts`.
        await ensureAuth(env, new URL(request.url).origin);

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async queue(batch: QueueBatchLike, env: Env): Promise<void> {
        // Platform-owned queue consumer for namespaced tenants (§2.4).
        await handleQueueBatch(batch, env);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        await runScheduled(controller, env, context, worker);
    },
};
