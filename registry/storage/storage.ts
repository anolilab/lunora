/**
 * Storage functions — added by `lunora registry add storage`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export the functions you want from your `lunora/`
 * entry (or rely on file-based discovery) so codegen picks them up — they
 * surface in the generated `api` as `storage/generateUploadUrl`,
 * `storage/getDownloadUrl`, `storage/deleteObject`, `storage/listObjects`
 * (i.e. `api.storage.generateUploadUrl` and friends).
 *
 *   - **generateUploadUrl** (action) — mint a short-lived signed `PUT` URL the
 *     browser uploads to. It points at YOUR Worker, not at R2: the `/storage/*`
 *     route (see the README) verifies the signature and writes the body to R2.
 *   - **getDownloadUrl** (action) — mint a short-lived signed `GET` URL for a
 *     stored object. The same `/storage/*` route verifies it with
 *     {@link verifySignedUrl} before streaming the R2 body.
 *   - **deleteObject** (mutation) — delete a stored object by key.
 *   - **listObjects** (action) — list stored objects under an optional prefix.
 *     An action, not a query: R2 is not a reactive source, so a query would never
 *     update on upload yet would re-issue a billable LIST on every unrelated
 *     mutation.
 *
 * Every key is scoped per-tenant with {@link scopeKey} so a client-supplied key
 * can't address another user's data (IDOR). Edit the scope to match your tenancy
 * model (per-user shown here via `ctx.auth.userId`).
 *
 * **Auth required by default.** Lunora queries/mutations/actions are public RPC,
 * so every handler here fails closed for unauthenticated callers via
 * {@link requireOwner} — otherwise an anonymous client could share a single
 * `public/` namespace and read/overwrite/delete other anonymous users' objects.
 * If you genuinely want a public namespace, do it deliberately and keep
 * destructive/mutating ops (`deleteObject`, `generateUploadUrl`) authenticated.
 *
 * Bindings + env used (declared in this item's registry.json, applied to
 * wrangler.jsonc / .dev.vars on add):
 *   - `env.UPLOADS`                 — the R2 bucket binding.
 *   - `env.STORAGE_SIGNING_SECRET`  — HMAC secret for signed URLs (secret).
 *   - `env.STORAGE_PUBLIC_BASE_URL` — bare origin serving the `/storage/*` route
 *                                     (no path: the key is verified from the
 *                                     whole URL pathname).
 */
import { env } from "cloudflare:workers";

import { LunoraError } from "@lunora/errors";
import { RateLimiter, rateLimit, createMemoryStore } from "@lunora/ratelimit";
import { createStorage, scopeKey } from "@lunora/storage";
import type { Storage } from "@lunora/storage";
import { action, mutation, v } from "#lunora/_generated/server.js";

/** The R2 bucket binding type `createStorage` expects. */
type StorageBucket = Parameters<typeof createStorage>[0]["bucket"];

/**
 * Per-user rate limit shared by the public storage endpoints, so they aren't
 * open flood targets. The default store is in-memory (per-isolate, resets on
 * eviction) — run `lunora add ratelimit` for the durable, `ctx.db`-backed store
 * in production, and tune the rate to your upload/download volume.
 *
 * The key at every `.use(...)` site below is the authenticated owner, falling
 * back to the server-trusted `ctx.ip` (Cloudflare's `CF-Connecting-IP`,
 * forwarded server-side, never read from a client header). The `ctx.ip` hop
 * matters even though every endpoint requires an owner: middleware runs BEFORE
 * the handler, so an unauthenticated caller consumes a token *before*
 * {@link requireOwner} rejects them. Keyed `"anon"` alone, every anonymous
 * client shares one bucket and a single one exhausts it for all of them — see
 * the `ratelimit_key_spoofable_or_global` advisor lint.
 */
const limiter = new RateLimiter({
    config: {
        storage: { kind: "token bucket", period: 60_000, rate: 60 },
    },
    store: createMemoryStore(),
});

/**
 * Read a required string env var/secret or throw a clear, actionable error.
 * (`cloudflare:workers`' `env` values are typed `unknown`, so we narrow here —
 * a missing `STORAGE_SIGNING_SECRET` fails loudly instead of producing an opaque
 * HMAC error deep in `@lunora/storage`.)
 *
 * `minLength` is the signing secret's floor. HMAC accepts a key of any length,
 * so a one-character secret signs perfectly well and every URL it mints is
 * brute-forceable — the documented "min 32 chars" has to be enforced here or it
 * is only advice.
 */
const requireEnv = (name: string, minLength = 0): string => {
    const value = env[name];

    if (typeof value !== "string" || value === "") {
        throw new Error(`@lunora/storage registry item: missing env var \`${name}\` — set it in .dev.vars (and \`wrangler secret put ${name}\` for secrets).`);
    }

    if (value.length < minLength) {
        throw new Error(
            `@lunora/storage registry item: \`${name}\` is only ${String(value.length)} characters — use at least ${String(minLength)} so signed URLs are not brute-forceable (generate one with \`openssl rand -base64 32\`).`,
        );
    }

    return value;
};

/** Minimum length of the HMAC signing secret. */
const MIN_SIGNING_SECRET_LENGTH = 32;

/**
 * Key prefix every object this item stores lives under.
 *
 * A worker-signed URL is `${STORAGE_PUBLIC_BASE_URL}/<key>?…` and
 * `verifySignedUrl` reconstructs the key from the WHOLE pathname — so the base
 * must be a bare origin and the route that serves the bytes has to match on the
 * key's own first segment. Prefixing every key with `storage/` is what makes the
 * documented `/storage/*` route match without a base-path the signer rejects.
 */
const KEY_PREFIX = "storage";

/**
 * Build a {@link Storage} bound to the R2 bucket + signing config from the
 * Worker env. Cheap to construct, so we make one per call rather than holding a
 * module-global (keeps it correct under per-isolate env injection). Throws with
 * a clear message if the `UPLOADS` binding or the signing config is missing.
 */
const makeStorage = (): Storage => {
    const bucket = env.UPLOADS as StorageBucket | undefined;

    if (!bucket) {
        throw new Error("@lunora/storage registry item: missing R2 binding `UPLOADS` — add it to wrangler.jsonc (see the README).");
    }

    return createStorage({
        bucket,
        // Bound into every signed URL's HMAC, so a URL minted here cannot be
        // replayed against another bucket sharing the signing secret. Matches the
        // tag a single-bucket app's bare `ctx.storage` carries.
        bucketName: "default",
        publicBaseUrl: requireEnv("STORAGE_PUBLIC_BASE_URL"),
        signingSecret: requireEnv("STORAGE_SIGNING_SECRET", MIN_SIGNING_SECRET_LENGTH),
    });
};

/**
 * Per-tenant key prefix: `storage/<userId>`, one folder per authenticated user,
 * so a client-supplied `key` is always namespaced under the caller (no
 * cross-user IDOR) and the minted URL's pathname starts `/storage/` — which is
 * what the Worker route in the README matches on (see {@link KEY_PREFIX}).
 *
 * Fails closed for unauthenticated callers instead of bucketing them into a
 * shared `public/` namespace. A shared anonymous prefix would let any anonymous
 * client read, overwrite, or delete every other anonymous client's objects, so
 * we require an authenticated identity. If you want a public namespace, add a
 * separate, read-only public path — never wire `deleteObject` /
 * `generateUploadUrl` to a shared anonymous prefix.
 */
const requireOwner = (userId: string | null): string => {
    if (userId === null || userId === undefined) {
        // Coded, not a bare `Error`: an uncoded throw is redacted to a generic
        // 500, so the caller sees a server fault instead of "sign in first".
        throw new LunoraError(
            "UNAUTHORIZED",
            "@lunora/storage registry item: this endpoint requires an authenticated user. Pass `resolveIdentity` to `createWorker` (see the auth registry item), or add a deliberate public path.",
        );
    }

    return `${KEY_PREFIX}/${userId}`;
};

/**
 * Content-Types a client may request for an upload. The browser PUTs with the
 * `Content-Type` pinned into the signed URL and the route stores exactly that
 * pinned value, so this allowlist is the only place to reject it —
 * `@lunora/storage`'s server-side `upload()` allowlist is never in the path. Deliberately
 * excludes types a browser may render inline (`text/html`, `image/svg+xml`, …)
 * to avoid stored-XSS if you ever serve these objects same-origin. Edit to taste,
 * and when serving objects set `X-Content-Type-Options: nosniff` +
 * `Content-Disposition: attachment` (or serve from a cookieless object host).
 */
const ALLOWED_UPLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp", "text/plain"]);

/**
 * Mint a short-lived signed `PUT` URL the client uploads to (your `/storage/*`
 * route, which verifies it and writes to R2). The key is scoped to the caller,
 * so two users uploading `"avatar.png"` never collide.
 * `contentType` is required and must be in {@link ALLOWED_UPLOAD_CONTENT_TYPES}
 * — it's pinned into the signature, so an unconstrained value would let a caller
 * store renderable HTML/SVG (stored-XSS risk when served same-origin).
 */
export const generateUploadUrl = action
    .input({
        contentType: v.string().max(256),
        expiresInSeconds: v.optional(v.number()),
        key: v.string().max(1024),
    })
    .use(rateLimit(limiter, "storage", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { contentType, expiresInSeconds, key }, ctx }): Promise<{ key: string; url: string }> => {
        if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
            // The value is caller-supplied, so this is a 400 the client can act
            // on — an uncoded throw would redact it to a generic 500.
            throw new LunoraError(
                "BAD_REQUEST",
                `@lunora/storage registry item: content type \`${contentType}\` is not allowed — permitted: ${[...ALLOWED_UPLOAD_CONTENT_TYPES].join(", ")}. Edit ALLOWED_UPLOAD_CONTENT_TYPES to widen.`,
            );
        }

        const scoped = scopeKey(requireOwner(ctx.auth.userId), key);
        const url = await makeStorage().generateUploadUrl(scoped, { contentType, expiresInSeconds });

        return { key: scoped, url };
    });

/**
 * Mint a short-lived signed `GET` URL for a stored object. Your Worker's
 * `/storage/*` route verifies it with {@link verifySignedUrl} before streaming
 * the R2 body — without that route the URL 404s on the Lunora catch-all.
 */
export const getDownloadUrl = action
    .input({
        expiresInSeconds: v.optional(v.number()),
        key: v.string().max(1024),
    })
    .use(rateLimit(limiter, "storage", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { expiresInSeconds, key }, ctx }): Promise<{ key: string; url: string }> => {
        const scoped = scopeKey(requireOwner(ctx.auth.userId), key);
        const url = await makeStorage().getSignedUrl(scoped, { expiresInSeconds, method: "GET" });

        return { key: scoped, url };
    });

/** Delete a stored object owned by the caller. */
export const deleteObject = mutation
    .input({ key: v.string().max(1024) })
    .use(rateLimit(limiter, "storage", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .mutation(async ({ args: { key }, ctx }): Promise<{ ok: true }> => {
        const scoped = scopeKey(requireOwner(ctx.auth.userId), key);
        await makeStorage().delete(scoped);

        return { ok: true as const };
    });

/** A single listed object as returned by `listObjects`. */
interface StorageObject {
    /** Object key, relative to the caller's tenant prefix. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Body length in bytes. */
    size: number;
}

/**
 * List the caller's stored objects under an optional sub-prefix. Returns the R2
 * page cursor + `truncated` flag for pagination; keys are returned relative to
 * the caller's tenant prefix.
 *
 * **An action, not a query** — like {@link generateUploadUrl} and
 * {@link getDownloadUrl}, and for the same reason. R2 is not a reactive source:
 * a query here would never re-run when a file is uploaded (so the list would go
 * stale silently), while Lunora *would* re-evaluate it on every unrelated
 * mutation to the shard — issuing a billable R2 LIST each time. Refetch it after
 * an upload/delete instead of subscribing to it.
 */
export const listObjects = action
    .input({
        cursor: v.optional(v.string().max(2048)),
        limit: v.optional(v.number()),
        prefix: v.optional(v.string().max(1024)),
    })
    .use(rateLimit(limiter, "storage", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { cursor, limit, prefix }, ctx }): Promise<{ cursor?: string; objects: StorageObject[]; truncated?: boolean }> => {
        const base = requireOwner(ctx.auth.userId);
        const scopedPrefix = prefix === undefined ? `${base}/` : `${scopeKey(base, prefix)}`;
        const stripLength = `${base}/`.length;

        const page = await makeStorage().list(scopedPrefix, { cursor, limit });

        return {
            cursor: page.cursor,
            objects: page.objects.map((object) => {
                const item: StorageObject = {
                    key: object.key.slice(stripLength),
                    size: object.size,
                };

                if (object.sha256 !== undefined) {
                    item.sha256 = object.sha256;
                }

                return item;
            }),
            truncated: page.truncated,
        };
    });

export type { StorageObject };
