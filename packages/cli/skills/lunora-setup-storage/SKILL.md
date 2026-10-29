---
name: lunora-setup-storage
description: Adds R2-backed file storage to a Lunora app with the `storage` registry item (`@lunora/storage`). Covers worker-signed PUT/GET URLs, the `UPLOADS` R2 bucket binding, `STORAGE_SIGNING_SECRET` and `STORAGE_PUBLIC_BASE_URL`, per-user key scoping, and the `/storage/*` Worker route that verifies signatures and moves the bytes. Use when the user wants file or image uploads, avatars, attachments or gated downloads, runs `lunora add storage` or `lunora registry add storage`, edits `lunora/storage/index.ts`, or sees signed storage URLs return 404/403 or uploads fail CORS.
---

# Lunora Setup Storage

The `storage` registry item wraps `@lunora/storage`, an R2 adapter with HMAC
signed-URL helpers. It exposes Lunora functions for browser uploads, gated
downloads, delete and list. The client never holds a bucket credential.

A worker-signed URL points at your Worker, not at R2. Its shape is
`<base>/<key>?exp&method&bucket&sig`. The base is `ctx.origin` unless
`STORAGE_PUBLIC_BASE_URL` overrides it. The `/storage/*` route from Step 3
verifies the signature and moves the bytes, for both upload and download.
`@lunora/storage`'s `getPresignedUrl` takes the Worker out of the path, but it
needs S3 credentials and none of your rules apply to it.

If the project has no Lunora backend yet, start with `lunora-quickstart`.

## Step 1: Add the item

```bash
lunora add storage                          # asks for the R2 bucket name
lunora add storage --bucket my-app-uploads
lunora registry add storage                 # low-level: writes bucket_name "replace-me-uploads"
```

Then run `pnpm install` and `lunora codegen`. The item does the following:

1. Adds `@lunora/storage`, `@lunora/server`, `@lunora/errors` and `@lunora/ratelimit`.
2. Merges an R2 binding named `UPLOADS` into `r2_buckets` in `wrangler.jsonc`.
3. Writes `STORAGE_SIGNING_SECRET` (a secret) to `.dev.vars`, plus an empty, optional `STORAGE_PUBLIC_BASE_URL`.
4. Copies `lunora/storage/index.ts` into the project. The project owns this file. Codegen exposes its functions as `api.storage.generateUploadUrl`, `getDownloadUrl` and `listObjects` (actions) and `deleteObject` (mutation). Every one requires a signed-in user, because `requireOwner` throws `UNAUTHORIZED` otherwise, so set up auth first (`lunora-setup-auth`). Each is rate-limited per user to 60 requests a minute through an in-memory, per-isolate limiter. For a durable limiter, run `lunora add ratelimit`.

## Step 2: Configure the binding and secrets

| Name                      | Where                           | Notes                                                                                                                                   |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOADS`                 | `wrangler.jsonc` → `r2_buckets` | Set `bucket_name` to a real bucket: lowercase letters, digits and hyphens, 3–63 chars. Otherwise wrangler rejects it.                   |
| `STORAGE_SIGNING_SECRET`  | secret                          | At least 32 chars; a shorter secret throws on the first call. Use `openssl rand -base64 32`, then `wrangler secret put` for production. |
| `STORAGE_PUBLIC_BASE_URL` | optional var                    | See below.                                                                                                                              |

Leave `STORAGE_PUBLIC_BASE_URL` empty for most apps. URLs are then signed
against `ctx.origin`, which is correct in dev, in previews and in production.
Set it only in two cases:

- Another host, such as a CDN, serves `/storage/*`.
- You sign where no request is behind the call: a query, a scheduled job or a workflow step. None of these has a `ctx.origin`, so signing there throws.

The value must be a bare origin. The key is verified from the whole URL
pathname, so the signer rejects a base that includes a path. Outside local dev
the value must use `https://`, because a signed URL is a bearer credential.

## Step 3: Add the `/storage/*` route to the Worker

The app needs this route. Without it, every minted URL falls through to the
Lunora catch-all and returns 404. The route is also the only place the signature
is checked, so a route that skips `verifySignedUrl` lets anyone read any key.

`@lunora/server`'s `serveStorageObject(ctx, key, request, authorize)` covers the
download half. It handles `Range`/206, `ETag`, `nosniff` and the inline-safe
`content-disposition` list. It verifies nothing on its own, so call
`verifySignedUrl` inside its `authorize` gate. It also doesn't handle uploads.
Use it from an `httpAction`, where `ctx.storage` is in scope, when you need
`Range` seeking.

The standalone route below is a plain Worker `fetch` that only has the R2
binding. It handles both verbs and serves whole objects:

```ts
import { isSafeHeaderValue } from "@lunora/server";
import { verifySignedUrl } from "@lunora/storage";

/** Cap what a single signed PUT may store. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Origins allowed to upload cross-origin. Leave it empty when
 * `STORAGE_PUBLIC_BASE_URL` is your app's own origin — then `cors` is inert and
 * no browser ever preflights these routes.
 */
const ALLOWED_ORIGINS = new Set(["https://app.example.com"]);

/**
 * Types safe to render in the browser. Everything else downloads — an uploader
 * who pinned `text/html` or `image/svg+xml` must never get a same-origin script.
 * (`serveStorageObject` applies this same list.)
 */
const INLINE_SAFE = new Set([
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "image/apng",
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/webm",
]);

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/storage/")) {
            const origin = request.headers.get("origin");
            // `vary` rides on EVERY response, allowed origin or not: a shared
            // cache keyed on the URL alone would otherwise replay one origin's
            // `access-control-allow-origin` to another.
            const cors = {
                vary: "origin",
                ...(origin !== null && ALLOWED_ORIGINS.has(origin)
                    ? { "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, PUT", "access-control-allow-origin": origin }
                    : {}),
            };

            // Before the verb check and the signature check: a preflight carries
            // neither the signed method nor any credentials, so answering it
            // later would 405 every cross-origin upload.
            if (request.method === "OPTIONS") {
                return new Response(null, { headers: cors, status: 204 });
            }

            // The method is signed, so a GET URL cannot be replayed as a PUT —
            // check the verb anyway rather than relying on that alone.
            if (request.method !== (url.searchParams.get("method") ?? "GET")) {
                return new Response("method not allowed", { status: 405 });
            }

            const result = await verifySignedUrl(url, env.STORAGE_SIGNING_SECRET);

            if (!result.valid || result.key === undefined) {
                // Expose only `valid` — a precise reason is a signing oracle.
                return new Response("forbidden", { status: 403 });
            }

            if (request.method === "PUT") {
                // Store the content type the SIGNATURE pins, never the request's
                // own header: the allowlist ran when the URL was minted, so
                // trusting the header lets a caller mint for `image/png` and PUT
                // `text/html` — stored XSS on this origin.
                if (result.contentType === undefined) {
                    return new Response("upload URL carries no content type", { status: 400 });
                }

                // A declared length is the contract: R2 takes `request.body` as a
                // stream, so there is nothing to measure before the write, and
                // treating an ABSENT header as oversized would 413 every valid
                // streamed upload. Demand it (411) and enforce it (413).
                const declared = request.headers.get("content-length");

                if (declared === null) {
                    return new Response("content-length required", { status: 411 });
                }

                const length = Number(declared);

                if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES) {
                    return new Response("upload too large", { status: 413 });
                }

                await env.UPLOADS.put(result.key, request.body, { httpMetadata: { contentType: result.contentType } });

                // The preflight's answer does not carry over: without CORS
                // headers HERE too the browser passes preflight and then rejects
                // the actual response.
                return new Response(null, { headers: cors, status: 204 });
            }

            const object = await env.UPLOADS.get(result.key);

            if (!object) {
                return new Response("not found", { status: 404 });
            }

            // The stored content type came off an uploader-signed URL, so it is
            // attacker-influenced: a CR/LF/NUL in it either throws inside
            // `Headers` (an unhandled 500) or, on a permissive runtime, splits
            // the response. Reject the value rather than reflect it — this is
            // exactly what `isSafeHeaderValue` does inside `serveStorageObject`.
            const rawContentType = object.httpMetadata?.contentType;
            const contentType = rawContentType !== undefined && isSafeHeaderValue(rawContentType) ? rawContentType : "application/octet-stream";

            return new Response(object.body, {
                headers: {
                    ...cors,
                    // The URL expires; a cached copy would not. Without this a
                    // browser or CDN can keep serving private bytes past `exp`,
                    // with `verifySignedUrl` never consulted again.
                    "cache-control": "private, no-store",
                    ...(INLINE_SAFE.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "") ? {} : { "content-disposition": "attachment" }),
                    "content-type": contentType,
                    "x-content-type-options": "nosniff",
                },
            });
        }

        // ... your Lunora handler
        return new Response("not found", { status: 404 });
    },
};
```

CORS: if `STORAGE_PUBLIC_BASE_URL` is a different origin from the app, the
browser preflights the `PUT`. The browser then reads
`access-control-allow-origin` from the real response as well, which is why the
204 and the download response also spread `...cors`. Keep the base same-origin
and `ALLOWED_ORIGINS` can stay empty.

On a CDN or host-rewrite setup, pass `{ expectedHost }` to `verifySignedUrl`,
set to the host of `STORAGE_PUBLIC_BASE_URL`, so the signature is checked
against the host the URL was minted for.

## Step 4: Upload and download from the client

```ts
import { api } from "../lunora/_generated/api"; // path relative to your client file

// 1. Mint a signed PUT URL. contentType must be in ALLOWED_UPLOAD_CONTENT_TYPES
//    in lunora/storage/index.ts. The type is pinned into the signature, and the
//    route stores that pinned value, not the request header.
const { key, url } = await client.action(api.storage.generateUploadUrl, { key: "avatar.png", contentType: file.type });

// 2. Upload straight to the Worker's /storage/* route.
await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });

// 3. Later, mint a signed GET URL to display it.
const { url: downloadUrl } = await client.action(api.storage.getDownloadUrl, { key: "avatar.png" });
```

Every key is scoped as `storage/<userId>/<key>`, so a key from the client can't
reach another user's data. The `storage/` prefix is also what routes the minted
URL to `/storage/*`. The functions return the scoped key: persist it if you
like, but always pass the bare key back in, because the function scopes it
again. `listObjects` is an action, not a query, because R2 isn't reactive.
Refetch it after an upload or a delete.

## Pitfalls

- **Signing secret reuse.** Signed URLs carry the bucket name inside the HMAC, so they can't be replayed across buckets. They can be replayed across deployments: two apps that share a secret will each honor URLs the other minted. Give each deployment its own secret.
- **File bodies through functions.** Bytes stream through the `/storage/*` route. Don't pass file contents as a `query`/`mutation`/`action` argument or return value.
- **Content types.** Widen the upload list through `ALLOWED_UPLOAD_CONTENT_TYPES`. Leave out `text/html` and `image/svg+xml`, since an uploaded one served from your origin is stored XSS.

## Verify

1. Run `lunora dev`, sign in, and upload a file through `generateUploadUrl` and `PUT`. The PUT should return 204.
2. Open the URL from `getDownloadUrl`. It should return the bytes with `cache-control: private, no-store`.
3. Change one character of `sig` in that URL. The route should return 403.
4. Before deploying, check that `bucket_name` is a real bucket and that `STORAGE_SIGNING_SECRET` was set with `wrangler secret put`.
