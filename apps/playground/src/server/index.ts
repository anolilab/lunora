import type { LunoraAuthOptions } from "@lunora/auth";
import { admin, organization, passkey, twoFactor } from "@lunora/auth/plugins";
import type { D1DatabaseLike } from "@lunora/d1";
import { createMailerFromEnv } from "@lunora/mail";
import type { ForwardableEmailMessageLike, ShardNamespaceLike as InboundShardNamespaceLike } from "@lunora/mail/inbound";
import { authenticatesFrom, createInboundEmailHandler, dispatchToLunoraFunction, parseInboundEmail } from "@lunora/mail/inbound";
import type { DurableObjectNamespaceLike } from "@lunora/scheduler";
import { createScheduler } from "@lunora/scheduler";
import type { R2BucketLike } from "@lunora/storage";
import { buildSignedUrl, verifySignedUrl } from "@lunora/storage";
import type { ExecutionContextLike, ScheduledControllerLike, ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../../lunora/_generated/app.js";

// WorkflowEntrypoint class for `lunora/workflows.ts` — wrangler requires every
// declared `workflows[].class_name` to be exported by the worker entry.
export { ChannelWelcomeWorkflow } from "../../lunora/_generated/workflows.js";
export { SchedulerDO } from "./scheduler-do.js";

interface Env extends Record<string, unknown> {
    AUTH_SECRET?: string;
    /** Base URL the auth handler resolves callback URLs against. */
    AUTH_URL?: string;
    /** Second R2 bucket for the studio file browser's bucket picker. */
    AVATARS?: R2BucketLike;
    DB: D1DatabaseLike;

    FILES: R2BucketLike;
    /** Bearer token gating the admin export/import and scheduled-job endpoints. */
    LUNORA_ADMIN_TOKEN?: string;

    /**
     * When set to the literal string `"true"`, the worker exposes a small
     * surface of `/test/*` helpers (reset DO state, mint a short-lived signed
     * URL, schedule a job, etc.) used by the `@lunora/e2e` Playwright suite.
     * The flag is read in `apps/playground/wrangler.jsonc` and injected via
     * `tests/e2e/globalSetup.ts` — *never* set this in production.
     */
    LUNORA_E2E?: string;
    /** Origin the SchedulerDO dispatches HTTP callbacks back to (job execution). */
    LUNORA_WORKER_ORIGIN?: string;
    /** Sender address for auth (verification / reset) email; captured into the studio Mail tab in dev. */
    MAIL_FROM?: string;
    /** Public base URL R2 objects resolve against — used to mint signed URLs. */
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER: DurableObjectNamespaceLike & ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    STORAGE_SECRET?: string;
}

/**
 * The runtime's default shard key (`WorkerOptions.defaultShardKey`). Every call
 * that names no shard — a client RPC on an unsharded table, the inbound-email
 * dispatch below, and every scheduler/cron dispatch — resolves here.
 */
const ROOT_SHARD_KEY = "__root__";

/**
 * Auth config the builder's `.auth()` lazily builds the runtime + migration
 * instances from — same plugins/secret so both describe the identical schema.
 * The full plugin set is what the studio's auth dashboard adapts to
 * (capability-detected by `createAuthAdmin`): `admin` → user management;
 * `organization` → the Organizations section; `twoFactor` → 2FA disable;
 * `passkey` → passkey list.
 */
const authOptions = (env: Env): LunoraAuthOptions => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    return {
        baseURL: env.AUTH_URL,
        // The E2E suite signs up many users in quick succession; better-auth's
        // built-in rate limiter would 429 them. Disable it only for the E2E run
        // (normal dev/prod keep better-auth's default rate limiting).
        rateLimit: env.LUNORA_E2E === "true" ? { enabled: false } : undefined,
        emailAndPassword: {
            enabled: true,
            // Forgot-password mail routes through @lunora/mail; in dev (and the
            // E2E run) it's captured into the studio's Mail tab — see mail-reset.spec.ts.
            sendResetPassword: async ({ url, user }) => {
                await createMailerFromEnv(env).send({
                    subject: "Reset your password",
                    text: `Reset your password:\n${url}`,
                    to: user.email,
                });
            },
        },
        plugins: [admin({ defaultRole: "user" }), organization({ allowUserToCreateOrganization: true }), twoFactor(), passkey()],
        secret: env.AUTH_SECRET,
    };
};

/**
 * The whole worker, composed with the generated `defineApp` builder. Each
 * capability is declared once and fanned into both the DO-side `ctx.*` factory
 * and the worker-side studio/admin surface:
 *   - `.storage()` — multi-bucket `ctx.storage` (FILES + AVATARS) + the studio
 *     file browser + signed-URL action.
 *   - `.scheduler()` — `ctx.scheduler` + the studio's scheduled-jobs view.
 *   - `.global()` — D1-backed `.global()` tables (channels/users) + the studio
 *     global browser + reverse cross-shard relations.
 *   - `.auth()` — better-auth (lazy build + `ensureMigrated` + `/api/auth/*`
 *     dispatch + identity resolution + the studio's user dashboard).
 *   - `.onEmail()` — Cloudflare Inbound Email Routing → the `inbound:onEmail`
 *     mutation over the root shard.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Required by `lunora/shapes.ts`: a shard-local `defineShape` replicates out
    // of `__cdc_log`, so without this the subscribe is refused. It used to be
    // accepted and then never deliver another row, which is how this app shipped
    // a shape that seeded once and silently froze.
    .cdc()
    .storage({
        bucket: (env) => env.FILES,
        buckets: { avatars: (env) => env.AVATARS },
        publicBaseUrl: (env) => env.PUBLIC_STORAGE_BASE_URL,
        signingSecret: (env) => env.STORAGE_SECRET,
    })
    .scheduler({ namespace: (env) => env.SCHEDULER })
    .global({ d1: (env) => env.DB, origin: (env) => env.LUNORA_WORKER_ORIGIN })
    .auth({ d1: (env) => env.DB, options: authOptions })
    .admin((env) => env.LUNORA_ADMIN_TOKEN)
    .onEmail((env) => async (message, _workerEnv, context) => {
        // Cloudflare delivers received mail here; parse it and dispatch the
        // normalised message into `inbound:onEmail` over the root shard's admin
        // RPC. `receivedAt` is stamped here (a non-deterministic context) so the
        // `onEmail` mutation handler stays deterministic.
        const handler = createInboundEmailHandler({
            dispatch: dispatchToLunoraFunction({
                functionPath: "inbound:onEmail",
                resolveArgs: (parsed) => {
                    return {
                        from: parsed.from,
                        messageId: parsed.messageId,
                        receivedAt: Date.now(),
                        subject: parsed.subject,
                        text: parsed.text,
                        to: parsed.to,
                    };
                },
                shard: env.SHARD as unknown as InboundShardNamespaceLike,
                shardKey: ROOT_SHARD_KEY,
            }),
            parse: parseInboundEmail,
            // SECURITY: Cloudflare Email Routing authenticates the RECIPIENT
            // domain, never the sender, and this dispatch reaches
            // `inbound:onEmail` over the root shard's ADMIN RPC — a Lunora
            // function running with the admin bearer and RLS disabled. Without
            // this gate anyone who can send mail to the routed address reaches
            // that, choosing `from` freely.
            //
            // `authenticatesFrom` is `@lunora/mail`'s one implementation of the
            // rule: accept only when some reported DMARC/SPF/DKIM clause both
            // passes AND names the `From` address's own domain. Do not hand-roll
            // it — the copy that used to live here asked only "did any clause
            // pass?", which an attacker satisfies with a genuine `spf=pass` +
            // `dkim=pass` for the domain THEY control while forging `From`.
            verify: authenticatesFrom,
        });

        await handler(message as ForwardableEmailMessageLike, env, context);
    })
    // This playground has `.auth()` but no per-row RLS on every table, so leaving
    // shard access OPEN would let an unauthenticated caller reach any channel's
    // shard. Gate it on authentication instead: reaching a shard requires a
    // signed-in user.
    //
    // `authorizeShard` only ever sees client-originated access, so `identity ===
    // null` here means an anonymous end user and nothing else — crons and
    // scheduled jobs are dispatched inside the trust boundary and never reach it.
    //
    // (This is a coarse gate — a real multi-tenant app should check the caller
    // OWNS the shard, e.g. `identity?.userId === ownerOf(shardKey)`, and add
    // per-row RLS as defense-in-depth.)
    .extend(() => {
        return { authorizeShard: ({ identity }) => identity?.userId !== undefined };
    })
    .build();

export const { ShardDO } = app;

/** The slice of D1 the reset needs: list tables, then empty them. */
interface D1Reset {
    prepare: (sql: string) => {
        all: () => Promise<{ results: { name: string }[] }>;
        run: () => Promise<unknown>;
    };
}

/**
 * Clear D1 between tests: empty every user table (auth `user`/`session`/… plus
 * app tables) so each spec starts from a known-empty database. We DELETE rather
 * than DROP so the schema survives and no re-migration is needed, and we delete
 * in reverse creation order (children before parents) so foreign-key references
 * don't block the clear.
 */
const clearD1 = async (database: D1Reset): Promise<void> => {
    const { results } = await database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
        .all();

    // Children-before-parents (reverse creation order) so FK references don't
    // block the clear. A plain reverse for-loop — `toReversed()` isn't in the
    // Node-16 target and `[...].reverse()` trips the lint.
    for (let index = results.length - 1; index >= 0; index -= 1) {
        const { name } = results[index];

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential DELETEs; the table set is tiny
            await database.prepare(`DELETE FROM "${name}"`).run();
        } catch {
            // A FK-blocked table clears on the next pass; best-effort per table.
        }
    }
};

const handleTestReset = async (env: Env): Promise<Response> => {
    try {
        const id = env.SHARD.idFromName("__e2e_reset__");
        const stub = env.SHARD.get(id);

        await stub.fetch(new Request("https://do/internal/reset", { method: "POST" }));
    } catch {
        // best-effort
    }

    try {
        await clearD1(env.DB);
    } catch {
        // best-effort — a fresh DB (pre-migration) has no tables to clear
    }

    return Response.json({ ok: true });
};

const handleTestSign = async (request: Request, env: Env): Promise<Response> => {
    if (!env.STORAGE_SECRET || !env.PUBLIC_STORAGE_BASE_URL) {
        return Response.json({ error: "STORAGE_SECRET and PUBLIC_STORAGE_BASE_URL must both be configured", url: null }, { status: 500 });
    }

    const body = (await request.json().catch(() => null)) as {
        contentType?: string;
        expiresInSeconds?: number;
        key?: string;
        method?: "GET" | "PUT";
    } | null;

    if (!body?.key) {
        return Response.json({ error: "`key` is required", url: null }, { status: 400 });
    }

    const signed = await buildSignedUrl({
        baseUrl: env.PUBLIC_STORAGE_BASE_URL,
        // PUT-only pin, forwarded so a harness upload can send a real
        // `content-type`: the PUT handler compares the header against the
        // signed value unconditionally, so an unpinned URL only accepts a body
        // with no content type.
        contentType: body.contentType,
        // The app declares two buckets (`FILES` as the default, `AVATARS` under
        // the `avatars` tag). `createStorage` signs the unnamed one under the
        // canonical `"default"` tag — mint the e2e URLs the same way or they
        // verify against a different canonical.
        bucketName: "default",
        expiresInSeconds: body.expiresInSeconds,
        key: body.key,
        method: body.method ?? "GET",
        secret: env.STORAGE_SECRET,
    });

    return Response.json({ url: signed });
};

const handleTestSchedule = async (request: Request, env: Env): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as {
        args?: Record<string, unknown>;
        delayMs?: number;
        functionPath?: string;
        scheduledFor?: number;
    } | null;

    if (!body?.functionPath) {
        return Response.json({ error: "`functionPath` is required", jobId: null }, { status: 400 });
    }

    const scheduler = createScheduler({ namespace: env.SCHEDULER });
    const scheduledFor = body.scheduledFor ?? Date.now() + (body.delayMs ?? 0);

    // `runAt` resolves the bare job id; `scheduledFor` is the instant we just
    // computed and passed in, so the response shape is unchanged.
    const jobId = await scheduler.runAt(scheduledFor, { __lunoraRef: body.functionPath }, body.args ?? {});

    return Response.json({ jobId, scheduledFor });
};

/**
 * E2E-only test helpers. Each route is a no-op unless `env.LUNORA_E2E ===
 * "true"`; in production traffic the dispatch falls through to the main
 * worker. We mount them *before* the composed worker so the runtime never sees
 * a `/test/*` path when the gate is closed.
 */
const handleTestRoute = async (request: Request, env: Env): Promise<Response | null> => {
    if (env.LUNORA_E2E !== "true") {
        return null;
    }

    const url = new URL(request.url);

    if (!url.pathname.startsWith("/test/")) {
        return null;
    }

    const { method } = request;

    if (url.pathname === "/test/reset" && method === "POST") {
        return handleTestReset(env);
    }

    if (url.pathname === "/test/sign" && method === "POST") {
        return handleTestSign(request, env);
    }

    if (url.pathname === "/test/schedule" && method === "POST") {
        return handleTestSchedule(request, env);
    }

    if (url.pathname === "/test/job-status" && method === "GET") {
        const id = url.searchParams.get("id");

        if (!id || !env.SCHEDULER) {
            return Response.json({ status: "unknown" });
        }

        const scheduler = createScheduler({ namespace: env.SCHEDULER });
        const record = await scheduler.get(id);

        // The SchedulerDO deletes a job's rows once it completes successfully, so
        // a previously-scheduled id with no record left has executed.
        return Response.json({ status: record ? "scheduled" : "executed" });
    }

    return new Response("not found", { status: 404 });
};

/**
 * Serve `@lunora/storage` signed URLs. The signer mints a URL under
 * `PUBLIC_STORAGE_BASE_URL` carrying the object key plus expiry/method/signature
 * query params; in production that base is a CDN/Worker route, but in dev the
 * Worker shares its origin, so the signed URL lands back here. We verify the
 * HMAC + expiry, then stream the R2 body (GET) or store the uploaded bytes
 * (PUT). The `avatars/` prefix is the only key namespace the playground signs,
 * and it can't collide with the `/_lunora`, `/api/auth`, `/test` routes the
 * Worker otherwise owns.
 */
const handleStorageAsset = async (request: Request, env: Env): Promise<null | Response> => {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/avatars/")) {
        return null;
    }

    if (!env.STORAGE_SECRET || !env.FILES) {
        return new Response("storage not configured", { status: 500 });
    }

    // The signed `method` is HMAC-bound, so a GET URL can't be replayed as a PUT;
    // still require the request verb to match what was signed.
    if (request.method !== (url.searchParams.get("method") ?? "GET")) {
        return new Response("method not allowed", { status: 405 });
    }

    const verdict = await verifySignedUrl(request.url, env.STORAGE_SECRET);

    if (!verdict.valid) {
        // Opaque 403 — never leak expired-vs-bad-signature (a signing oracle).
        return new Response("forbidden", { status: 403 });
    }

    // The bucket is HMAC-bound, so this is the URL's own claim about which
    // binding to serve — never a caller-supplied parameter. Only the default
    // bucket is served here: the app also declares `avatars`, but nothing mints
    // a URL against it (`lunora/avatars.ts` writes `avatars/`-prefixed keys into
    // the default bucket), so a URL naming any other bucket was minted for an
    // app we are not. Serving `avatars` means resolving the binding here first.
    if (verdict.bucketName !== "default") {
        return new Response("forbidden", { status: 403 });
    }

    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method === "PUT") {
        // The signed `Content-Type` pin is bound into the HMAC precisely so the
        // uploader can't swap it. Storing the request's header verbatim would let
        // a URL pinned to `image/png` land a `text/html` body that the GET branch
        // below then serves back as HTML from this origin — stored XSS.
        //
        // The comparison is UNCONDITIONAL. Skipping it when the URL carries no
        // pin (`verdict.contentType === undefined`) hands the choice straight
        // back to the uploader — exactly the hole the pin exists to close — so
        // an unpinned URL accepts only a body with no `content-type` at all,
        // which stores (and later serves) as `application/octet-stream`. Mint a
        // pinned URL (`buildSignedUrl({ contentType })`) to upload a typed body.
        const contentType = request.headers.get("content-type") ?? undefined;

        if (contentType !== verdict.contentType) {
            return new Response("content-type does not match the signed URL", { status: 415 });
        }

        await env.FILES.put(key, request.body, { httpMetadata: { contentType } });

        return new Response(null, { status: 200 });
    }

    const object = await env.FILES.get(key);

    if (!object) {
        return new Response("not found", { status: 404 });
    }

    return new Response(object.body, {
        headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
};

/**
 * Inbound Email Routing entry (`@lunora/mail/inbound`) — wired by the builder's
 * `.onEmail(...)`. Cloudflare delivers received mail to this top-level
 * `email(message, env, ctx)` export (a sibling of `fetch`/`scheduled`).
 */
export const { email } = app;

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        // App-specific pre-worker routing: the e2e `/test/*` helpers and the
        // `/avatars/*` signed-asset endpoint run ahead of the composed worker so
        // it never sees those paths. Everything else (RPC, WebSocket, auth, admin)
        // is the builder's `app.fetch` — which also owns the auth lazy-init.
        const testResponse = await handleTestRoute(request, env);

        if (testResponse) {
            return testResponse;
        }

        const assetResponse = await handleStorageAsset(request, env);

        if (assetResponse) {
            return assetResponse;
        }

        return app.fetch(request, env, context);
    },
    queue(batch: MessageBatch, env: Env, context: ExecutionContextLike): Promise<void> {
        // Cloudflare delivers each consumed batch here; the generated `app.queue`
        // routes it to the matching `defineQueue` handler in `lunora/queues.ts` and,
        // in dev, captures every outcome into the studio's Queues panel. `queue` is
        // optional on the composed app (present only when queues are declared), so
        // guard it and no-op otherwise.
        return app.queue?.(batch, env, context) ?? Promise.resolve();
    },
    scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        return app.scheduled(controller, env, context);
    },
};
