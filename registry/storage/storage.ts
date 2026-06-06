/**
 * Storage functions — added by `cirrus registry add storage`.
 *
 * This file is YOURS: it's a normal Cirrus module, copied into your project so
 * you own and edit it. Re-export the functions you want from your `cirrus/`
 * entry (or rely on file-based discovery) so codegen picks them up — they
 * surface in the generated `api` as `storage/generateUploadUrl`,
 * `storage/getDownloadUrl`, `storage/deleteObject`, `storage/listObjects`
 * (i.e. `api.storage.generateUploadUrl` and friends).
 *
 *   - **generateUploadUrl** (action) — mint a short-lived signed `PUT` URL the
 *     browser can upload directly to (R2 never proxies bytes through the Worker).
 *   - **getDownloadUrl** (action) — mint a short-lived signed `GET` URL for a
 *     stored object. Gate the matching `GET /storage/:key` route in your Worker
 *     with {@link verifySignedUrl} before streaming the R2 body.
 *   - **deleteObject** (mutation) — delete a stored object by key.
 *   - **listObjects** (query) — list stored objects under an optional prefix.
 *
 * Every key is scoped per-tenant with {@link scopeKey} so a client-supplied key
 * can't address another user's data (IDOR). Edit the scope to match your tenancy
 * model (per-user shown here via `ctx.auth.userId`).
 *
 * Bindings + env used (declared in this item's registry.json, applied to
 * wrangler.jsonc / .dev.vars on add):
 *   - `env.UPLOADS`                 — the R2 bucket binding.
 *   - `env.STORAGE_SIGNING_SECRET`  — HMAC secret for signed URLs (secret).
 *   - `env.STORAGE_PUBLIC_BASE_URL` — public base URL fronting the bucket.
 */
import { env } from "cloudflare:workers";

import { createStorage, scopeKey } from "@cirrus/storage";
import type { Storage } from "@cirrus/storage";
import { action, mutation, query, v } from "@cirrus/server";

/** The R2 bucket binding type `createStorage` expects. */
type StorageBucket = Parameters<typeof createStorage>[0]["bucket"];

/**
 * Read a required string env var/secret or throw a clear, actionable error.
 * (`cloudflare:workers`' `env` values are typed `unknown`, so we narrow here —
 * a missing `STORAGE_SIGNING_SECRET` fails loudly instead of producing an opaque
 * HMAC error deep in `@cirrus/storage`.)
 */
const requireEnv = (name: string): string => {
    const value = env[name];

    if (typeof value !== "string" || value === "") {
        throw new Error(`@cirrus/storage registry item: missing env var \`${name}\` — set it in .dev.vars (and \`wrangler secret put ${name}\` for secrets).`);
    }

    return value;
};

/**
 * Build a {@link Storage} bound to the R2 bucket + signing config from the
 * Worker env. Cheap to construct, so we make one per call rather than holding a
 * module-global (keeps it correct under per-isolate env injection). Throws with
 * a clear message if the `UPLOADS` binding or the signing config is missing.
 */
const makeStorage = (): Storage => {
    const bucket = env.UPLOADS as StorageBucket | undefined;

    if (!bucket) {
        throw new Error("@cirrus/storage registry item: missing R2 binding `UPLOADS` — add it to wrangler.jsonc (see the README).");
    }

    return createStorage({
        bucket,
        publicBaseUrl: requireEnv("STORAGE_PUBLIC_BASE_URL"),
        signingSecret: requireEnv("STORAGE_SIGNING_SECRET"),
    });
};

/**
 * Per-tenant key prefix. Defaults to one folder per authenticated user so a
 * client-supplied `key` is always namespaced under the caller. Falls back to a
 * shared `public/` prefix for unauthenticated callers — tighten or remove that
 * branch to require auth.
 */
const tenantPrefix = (userId?: string): string => userId ?? "public";

/**
 * Mint a short-lived signed `PUT` URL the client uploads directly to. The key is
 * scoped to the caller, so two users uploading `"avatar.png"` never collide.
 * Optionally pins the request `Content-Type` into the signature.
 */
export const generateUploadUrl = action({
    args: {
        contentType: v.optional(v.string()),
        expiresInSeconds: v.optional(v.number()),
        key: v.string(),
    },
    handler: async (ctx, { contentType, expiresInSeconds, key }): Promise<{ key: string; url: string }> => {
        const scoped = scopeKey(tenantPrefix(ctx.auth.userId ?? undefined), key);
        const url = await makeStorage().generateUploadUrl(scoped, { contentType, expiresInSeconds });

        return { key: scoped, url };
    },
});

/**
 * Mint a short-lived signed `GET` URL for a stored object. Verify it in your
 * Worker's `GET /storage/:key` route with {@link verifySignedUrl} before
 * streaming the R2 body.
 */
export const getDownloadUrl = action({
    args: {
        expiresInSeconds: v.optional(v.number()),
        key: v.string(),
    },
    handler: async (ctx, { expiresInSeconds, key }): Promise<{ key: string; url: string }> => {
        const scoped = scopeKey(tenantPrefix(ctx.auth.userId ?? undefined), key);
        const url = await makeStorage().getSignedUrl(scoped, { expiresInSeconds, method: "GET" });

        return { key: scoped, url };
    },
});

/** Delete a stored object owned by the caller. */
export const deleteObject = mutation({
    args: { key: v.string() },
    handler: async (ctx, { key }): Promise<{ ok: true }> => {
        const scoped = scopeKey(tenantPrefix(ctx.auth.userId ?? undefined), key);
        await makeStorage().delete(scoped);

        return { ok: true as const };
    },
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
 * List the caller's stored objects under an optional sub-prefix. Read-only, so
 * it's a query. Returns the R2 page cursor + `truncated` flag for pagination;
 * keys are returned relative to the caller's tenant prefix.
 */
export const listObjects = query({
    args: {
        cursor: v.optional(v.string()),
        limit: v.optional(v.number()),
        prefix: v.optional(v.string()),
    },
    handler: async (ctx, { cursor, limit, prefix }): Promise<{ cursor?: string; objects: StorageObject[]; truncated?: boolean }> => {
        const base = tenantPrefix(ctx.auth.userId ?? undefined);
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
    },
});

export type { StorageObject };
