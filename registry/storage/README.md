# storage

R2-backed file storage for Lunora. Wraps [`@lunora/storage`](../../packages/storage)'s `createStorage` over a Cloudflare R2 bucket binding and exposes idiomatic Lunora functions — browser uploads via short-lived **signed PUT URLs**, gated downloads via **signed GET URLs**, plus delete and list. No bucket credential ever reaches the client.

A worker-signed URL points at **your Worker**, not at R2: it is `${STORAGE_PUBLIC_BASE_URL}/<key>?exp&method&bucket&sig`, and the `/storage/*` route below is what verifies the signature and moves the bytes. That route is the whole point — it is where your app gets to say yes or no. (If you want the browser to reach R2 with no Worker in the path, that is `@lunora/storage`'s S3 **presigned** URL, `getPresignedUrl`, which needs S3 credentials on the bucket and enforces nothing of yours.)

Every key is scoped per-tenant as `storage/<userId>/<key>`, so a client-supplied key can never address another user's data — and the `storage/` prefix is what puts the minted URL on the `/storage/*` route (`STORAGE_PUBLIC_BASE_URL` must be a bare origin; the signer rejects a base carrying a path, because the key is verified from the whole URL pathname).

## Install

```bash
lunora registry add storage
```

This:

1. Adds `@lunora/storage` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Adds an R2 bucket binding to `wrangler.jsonc` (`r2_buckets`, binding **`UPLOADS`**). `lunora init` and `lunora add storage` prompt for the bucket name (default `<project>-uploads`, or pass `--bucket <name>`); the low-level `lunora registry add storage` writes the placeholder `bucket_name: "replace-me-uploads"` — rename it to a real bucket.
3. Scaffolds `STORAGE_SIGNING_SECRET` (a secret — write a real value with `wrangler secret put STORAGE_SIGNING_SECRET`) and `STORAGE_PUBLIC_BASE_URL` into your `.dev.vars`.
4. Copies `lunora/storage/index.ts` (the `generateUploadUrl` / `getDownloadUrl` / `deleteObject` / `listObjects` functions) into your project — this is **yours** to edit.

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` as `storage/generateUploadUrl`, `storage/getDownloadUrl`, `storage/deleteObject`, and `storage/listObjects` — i.e. `api.storage.generateUploadUrl` and friends.

## Configure the binding + secrets

The component reads three things from your Worker env (`cloudflare:workers`):

| Name                      | Where                                | What                                                                                                                                          |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOADS`                 | `wrangler.jsonc` → `r2_buckets[]`    | The R2 bucket binding. Point `bucket_name` at a real bucket.                                                                                  |
| `STORAGE_SIGNING_SECRET`  | secret (`.dev.vars` / `secret put`)  | HMAC secret for signed URLs. Min 32 chars, **enforced** — a shorter one throws on the first call. Never share across buckets.                 |
| `STORAGE_PUBLIC_BASE_URL` | var (`.dev.vars` / `wrangler.jsonc`) | The **bare origin** running the `/storage/*` route (scaffolded as `http://localhost:8787`). A base carrying a path is rejected by the signer. |

The R2 binding `lunora registry add` writes:

```jsonc
// wrangler.jsonc
"r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "replace-me-uploads" }]
```

`lunora registry add` **merges** this into any existing `r2_buckets` (it won't drop buckets you already have); rename `bucket_name` to a real bucket. Generate a signing secret with `openssl rand -base64 32`.

## How it works

- **generateUploadUrl** (action) mints a short-lived signed `PUT` URL (`@lunora/storage`'s `generateUploadUrl`, built on `buildSignedUrl` with `method: "PUT"`). The browser `PUT`s the file to the `/storage/*` route, which verifies the signature and writes it to R2. `contentType` is **required** and checked against an allowlist (`ALLOWED_UPLOAD_CONTENT_TYPES` in the copied file): because the browser pins that `Content-Type` into the signed PUT, R2 never sees the server-side `upload()` allowlist, so this is the only place to reject renderable types (`text/html`, `image/svg+xml`) that would otherwise become stored XSS if served same-origin. Widen the set as needed, and when you serve objects set `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` (or use a cookieless object host).
- **getDownloadUrl** (action) mints a short-lived signed `GET` URL (`getSignedUrl` with `method: "GET"`). Your Worker's `/storage/*` route must verify it before streaming (see below).
- **deleteObject** (mutation) deletes an object by key.
- **listObjects** (action) lists the caller's objects under an optional prefix, returning the R2 page `cursor` + `truncated` flag for pagination. An action rather than a query because R2 is not a reactive source: a query would never re-run when a file is uploaded, yet Lunora would re-evaluate it on every unrelated mutation to the shard — a billable R2 LIST each time. Refetch after an upload or delete instead of subscribing.

All four scope the key with `scopeKey(requireOwner(ctx.auth.userId), key)` — `requireOwner` returns `storage/<userId>` — namespacing every object under the caller. They **require an authenticated identity** and fail closed otherwise (`requireOwner` throws) — these are public-by-default RPC, so a shared anonymous `public/` namespace would let any anonymous caller read, overwrite, or delete every other anonymous caller's objects. Wire `resolveIdentity` into `createWorker` (see the `auth` registry item) so `ctx.auth.userId` is populated. If you genuinely want a public namespace, add a separate **read-only** public path — never point `deleteObject` / `generateUploadUrl` at a shared anonymous prefix.

## Add the `/storage/*` route to your Worker

**This route is required, not optional.** Without it a minted URL resolves to your Worker's catch-all and every upload and download 404s. It is also the only thing checking the signature, so a missing check means anyone can read any key.

`@lunora/server`'s `serveStorageObject` does the download half — `Range`/206, `ETag`, `nosniff`, and `content-disposition: attachment` for anything outside a small inline-safe set (raster images plus `audio/mpeg`, `audio/ogg`, `audio/wav`, `video/mp4`, `video/webm`; `image/svg+xml` is deliberately excluded) — but it does **not** verify anything by itself, and it does not handle the upload. Its fourth argument, the `authorize` gate, is required and is where your check goes:

```ts
import { serveStorageObject } from "@lunora/server";
import { verifySignedUrl } from "@lunora/storage";

// inside an httpAction handler
return serveStorageObject(ctx, key, request, async ({ request: r }) => (await verifySignedUrl(new URL(r.url), env.STORAGE_SIGNING_SECRET)).valid);
```

`serveStorageObject` covers `GET` only. The upload half has no helper, so wire both verbs by hand:

```ts
// in your Worker entry — this runs BEFORE the Lunora handler
import { verifySignedUrl } from "@lunora/storage";

/** Cap what a single signed PUT may store. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/storage/")) {
            // The method is part of the signed payload, so a GET URL cannot be
            // replayed as a PUT — check the verb anyway rather than relying on
            // that alone.
            if (request.method !== (url.searchParams.get("method") ?? "GET")) {
                return new Response("method not allowed", { status: 405 });
            }

            const result = await verifySignedUrl(url, env.STORAGE_SIGNING_SECRET);

            if (!result.valid || result.key === undefined) {
                // Expose only `valid` — a precise reason is a signing oracle.
                return new Response("forbidden", { status: 403 });
            }

            if (request.method === "PUT") {
                // Store the content type the SIGNATURE pins, never the one the
                // request asks for. `generateUploadUrl` checked its allowlist
                // when it minted the URL and folded the value into the HMAC, so
                // `result.contentType` is the vetted one. Trusting the header
                // instead lets a caller mint for `image/png` and then PUT
                // `text/html` — stored XSS against this origin.
                if (result.contentType === undefined) {
                    return new Response("upload URL carries no content type", { status: 400 });
                }

                const length = Number(request.headers.get("content-length") ?? Number.NaN);

                if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES) {
                    return new Response("upload too large", { status: 413 });
                }

                await env.UPLOADS.put(result.key, request.body, { httpMetadata: { contentType: result.contentType } });

                return new Response(null, { status: 204 });
            }

            const object = await env.UPLOADS.get(result.key);

            if (!object) {
                return new Response("not found", { status: 404 });
            }

            return new Response(object.body, {
                headers: {
                    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
                    // The stored `content-type` was chosen by the uploader, so
                    // reflecting it same-origin without these two is a stored-XSS
                    // path: `nosniff` stops the browser upgrading a mislabelled
                    // body to HTML, and `attachment` stops it rendering one that
                    // is honestly labelled. `lunora/storage/index.ts`'s
                    // ALLOWED_UPLOAD_CONTENT_TYPES is the other half of this —
                    // keep both. Serving from a separate cookieless object host
                    // is the stronger answer if you need inline rendering.
                    "content-disposition": "attachment",
                    "x-content-type-options": "nosniff",
                },
            });
        }

        // ... your Lunora handler
        return new Response("not found", { status: 404 });
    },
};
```

`verifySignedUrl` checks expiry first, then the HMAC; on a host-rewrite / CDN topology pass `{ expectedHost }` (the `STORAGE_PUBLIC_BASE_URL` host) so the signature canonicalizes against the host it was minted for.

## Use it from a client

```ts
// 1. ask the server for a signed PUT URL
const { key, url } = await client.action("storage/generateUploadUrl", {
    key: "avatar.png",
    contentType: file.type,
});

// 2. upload it — the URL points at your Worker's `/storage/*` route, which
//    verifies the signature and writes to R2. The `content-type` must match
//    the one pinned into the signature or verification fails.
await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });

// 3. later, get a signed GET URL to display it
const { url: downloadUrl } = await client.action("storage/getDownloadUrl", { key: "avatar.png" });
```

`generateUploadUrl` / `getDownloadUrl` return the **scoped** key (`storage/<userId>/avatar.png`) alongside the URL, so you can persist it in your own tables; pass the bare key (`"avatar.png"`) back in — the component re-scopes it for you.

## What you own

Everything under `lunora/storage/` is copied into your repo — change the tenancy prefix, the default TTLs, add a `maxSize` / `allowedContentTypes` guard on uploads, or add `download` / `getMetadata` functions from `@lunora/storage` however you like. `@lunora/storage` provides the R2 adapter + signing helpers; this component is the idiomatic Lunora glue around them.
