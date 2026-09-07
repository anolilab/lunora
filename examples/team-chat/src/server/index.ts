import type { D1DatabaseLike } from "@lunora/d1";
import type { R2BucketLike } from "@lunora/storage";
import { verifySignedUrl } from "@lunora/storage";
import type { ExecutionContextLike, ScheduledControllerLike, ShardNamespaceLike } from "lunorash/runtime";

import { authOptions } from "../../lunora/auth.js";
import { defineApp } from "../../lunora/_generated/app.js";

interface Env {
    AUTH_SECRET: string;
    DB: D1DatabaseLike;
    FILES: R2BucketLike;
    SHARD: ShardNamespaceLike;
    /** HMAC secret for signed upload/download URLs. */
    STORAGE_SECRET?: string;
}

/** Ceiling on a single attachment. R2 would happily take more; the demo should not. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Origin that signed object URLs resolve against.
 *
 * Derived per-request rather than shipped as a `var`. `buildSignedUrl` binds the
 * HOST into the HMAC and `verifySignedUrl` canonicalises against the inbound
 * host, so a hard-coded `http://localhost:5173` — which is what a deploy would
 * carry, since the deploy flow prompts for secrets but copies `vars` verbatim —
 * mints URLs that fail their own signature check on the deployed origin, 403ing
 * every attachment and avatar.
 */
const storageOrigin = (request: Request): string => new URL(request.url).origin;

/**
 * The composed worker.
 *
 * `defineApp()` is generated from this project's schema, so each declaration
 * wires both halves of a capability at once — the `ctx.*` surface inside the
 * shard and the matching admin/studio surface on the worker. Doing this by hand
 * with `createWorker` + `createShardDO` is possible, and easy to get subtly
 * wrong: omit `.global()` and every read of the `.global()` `profiles` table
 * throws "no global backend configured" at runtime, with types that compiled
 * fine.
 *
 * - `.shard()`   — the Durable Object namespace all RPC and WebSocket traffic routes through.
 * - `.global()`  — the D1 binding backing the `.global()` `profiles` table.
 * - `.auth()`    — better-auth: builds the instance, runs the migration sweep, serves `/api/auth/*`, and resolves `ctx.auth.userId`.
 * - `.storage()` — the R2 bucket behind `ctx.storage`, plus the signing config the upload URLs need.
 * - `.extend()`  — anything the builder does not model; here, shard authorisation.
 */
const app = defineApp<Env & { PUBLIC_STORAGE_BASE_URL: string }>()
    .shard((env) => env.SHARD)
    .global({ d1: (env) => env.DB })
    .auth({ d1: (env) => env.DB, options: authOptions })
    .storage({
        bucket: (env) => env.FILES,
        // Set per request in `fetch` below — see `storageOrigin`.
        publicBaseUrl: (env) => env.PUBLIC_STORAGE_BASE_URL,
        signingSecret: (env) => env.STORAGE_SECRET,
    })
    .extend(() => ({
        /**
         * Shard keys come from the client, so the worker decides who may address
         * which shard. Channels are open to every signed-in member, so any
         * authenticated caller may address any channel — and an anonymous one may
         * address none. Without this the runtime rejects client-named shards
         * outright (403), which is the safe default.
         */
        authorizeShard: ({ identity }) => Boolean(identity?.userId),
    }))
    .build();

export const ShardDO = app.ShardDO;

/**
 * Serve the signed object URLs that `ctx.storage.generateUploadUrl` /
 * `getSignedUrl` mint.
 *
 * A signed URL binds host + key + method + expiry into an HMAC, and something
 * has to check it — R2 is not exposed to the internet here. This is that
 * endpoint: verify, then PUT into or stream out of the bucket. Uploads never
 * pass through the RPC layer, so a large attachment costs the Worker one
 * signature check rather than the whole body.
 *
 * The 403 is deliberately opaque: distinguishing "expired" from "bad signature"
 * would turn this into a signing oracle.
 */
const handleStorageAsset = async (request: Request, env: Env & { PUBLIC_STORAGE_BASE_URL: string }): Promise<Response | null> => {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/files/")) {
        return null;
    }

    if (!env.STORAGE_SECRET) {
        return new Response("storage signing is not configured", { status: 500 });
    }

    // The method is part of the signed payload, so a GET URL cannot be replayed
    // as a PUT — but check the verb anyway rather than relying on that alone.
    if (request.method !== (url.searchParams.get("method") ?? "GET")) {
        return new Response("method not allowed", { status: 405 });
    }

    const verdict = await verifySignedUrl(request.url, env.STORAGE_SECRET);

    if (!verdict.valid) {
        return new Response("forbidden", { status: 403 });
    }

    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method === "PUT") {
        // Store the content type the SIGNATURE pins, never the one the request
        // asks for. `requestAttachmentUpload` checks its allowlist when minting
        // the URL and `buildSignedUrl` folds the value into the HMAC, so
        // `verdict.contentType` is the vetted one. Trusting the header instead
        // lets a caller mint a URL for `image/png` and then PUT `text/html` to
        // it — and since this worker serves the bytes back from its own origin,
        // that is stored XSS against the session cookie's origin.
        if (verdict.contentType === undefined) {
            return new Response("upload URL carries no content type", { status: 400 });
        }

        const length = Number(request.headers.get("content-length") ?? Number.NaN);

        if (!Number.isFinite(length) || length > MAX_ATTACHMENT_BYTES) {
            return new Response("attachment too large", { status: 413 });
        }

        await env.FILES.put(key, request.body, { httpMetadata: { contentType: verdict.contentType } });

        return new Response(null, { status: 200 });
    }

    const object = await env.FILES.get(key);

    if (!object) {
        return new Response("not found", { status: 404 });
    }

    return new Response(object.body, {
        headers: {
            "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
            // Defence in depth behind the pinned content type: never let the
            // browser sniff a stored object into something executable, and never
            // render it inline on this origin.
            "content-disposition": "attachment",
            "x-content-type-options": "nosniff",
        },
    });
};

/**
 * This entry cannot `export default app` (the signed-asset route has to run
 * ahead of the worker and the origin has to be threaded onto `env`), so every
 * other handler `.build()` composes is forwarded by hand. `scheduled`, `queue`
 * and `email` appear the moment a `lunora/crons.ts`, a `defineQueue` or
 * `.onEmail(...)` is added, and `lunora deploy` provisions the matching trigger
 * from the same discovery — an entry exporting only `fetch` gets the trigger
 * without the handler and Cloudflare fires it into nothing.
 *
 * `scheduled`/`queue`/`email` take the raw `env`: `PUBLIC_STORAGE_BASE_URL` is
 * derived from the inbound request, and there is no request on those paths.
 */
export default {
    email(message: unknown, env: Env, context: ExecutionContextLike): Promise<void> {
        return app.email?.(message, env, context) ?? Promise.resolve();
    },
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        // The builder reads `publicBaseUrl` off `env`, so the request-derived
        // origin is threaded in here rather than shipped in `wrangler.jsonc`.
        const scoped = { ...env, PUBLIC_STORAGE_BASE_URL: storageOrigin(request) };

        return (await handleStorageAsset(request, scoped)) ?? app.fetch(request, scoped, context);
    },
    queue(batch: unknown, env: Env, context: ExecutionContextLike): Promise<void> {
        return app.queue?.(batch, env, context) ?? Promise.resolve();
    },
    scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        return app.scheduled(controller, env, context);
    },
};
