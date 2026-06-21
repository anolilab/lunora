# storage

R2-backed file storage for Lunora. Wraps [`@lunora/storage`](../../packages/storage)'s `createStorage` over a Cloudflare R2 bucket binding and exposes idiomatic Lunora functions — direct browser uploads via short-lived **signed PUT URLs**, gated downloads via **signed GET URLs**, plus delete and list — so the bytes never proxy through your Worker.

Every key is scoped per-tenant with `scopeKey`, so a client-supplied key can never address another user's data.

## Install

```bash
lunora registry add storage
```

This:

1. Adds `@lunora/storage` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Adds an R2 bucket binding to `wrangler.jsonc` (`r2_buckets`, binding **`UPLOADS`**, `bucket_name: "REPLACE_ME-uploads"` — rename it to a real bucket).
3. Scaffolds `STORAGE_SIGNING_SECRET` (a secret — write a real value with `wrangler secret put STORAGE_SIGNING_SECRET`) and `STORAGE_PUBLIC_BASE_URL` into your `.dev.vars`.
4. Copies `lunora/storage/index.ts` (the `generateUploadUrl` / `getDownloadUrl` / `deleteObject` / `listObjects` functions) into your project — this is **yours** to edit.

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` as `storage/generateUploadUrl`, `storage/getDownloadUrl`, `storage/deleteObject`, and `storage/listObjects` — i.e. `api.storage.generateUploadUrl` and friends.

## Configure the binding + secrets

The component reads three things from your Worker env (`cloudflare:workers`):

| Name                      | Where                                | What                                                                         |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `UPLOADS`                 | `wrangler.jsonc` → `r2_buckets[]`    | The R2 bucket binding. Point `bucket_name` at a real bucket.                 |
| `STORAGE_SIGNING_SECRET`  | secret (`.dev.vars` / `secret put`)  | HMAC secret for signed URLs. Min 32 chars; **never share across buckets**.   |
| `STORAGE_PUBLIC_BASE_URL` | var (`.dev.vars` / `wrangler.jsonc`) | The public host/route that fronts the bucket and serves `GET /storage/:key`. |

The R2 binding `lunora registry add` writes:

```jsonc
// wrangler.jsonc
"r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "REPLACE_ME-uploads" }]
```

`lunora registry add` **merges** this into any existing `r2_buckets` (it won't drop buckets you already have); rename `bucket_name` to a real bucket. Generate a signing secret with `openssl rand -base64 32`.

## How it works

- **generateUploadUrl** (action) mints a short-lived signed `PUT` URL (`@lunora/storage`'s `generateUploadUrl`, built on `buildSignedUrl` with `method: "PUT"`). The browser `PUT`s the file straight to R2 — the bytes never touch your Worker. `contentType` is **required** and checked against an allowlist (`ALLOWED_UPLOAD_CONTENT_TYPES` in the copied file): because the browser pins that `Content-Type` into the signed PUT, R2 never sees the server-side `upload()` allowlist, so this is the only place to reject renderable types (`text/html`, `image/svg+xml`) that would otherwise become stored XSS if served same-origin. Widen the set as needed, and when you serve objects set `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` (or use a cookieless object host).
- **getDownloadUrl** (action) mints a short-lived signed `GET` URL (`getSignedUrl` with `method: "GET"`). Your Worker's `GET /storage/:key` route must verify it before streaming (see below).
- **deleteObject** (mutation) deletes an object by key.
- **listObjects** (query) lists the caller's objects under an optional prefix, returning the R2 page `cursor` + `truncated` flag for pagination.

All four scope the key with `scopeKey(requireOwner(ctx.auth.userId), key)`, namespacing every object under the caller. They **require an authenticated identity** and fail closed otherwise (`requireOwner` throws) — these are public-by-default RPC, so a shared anonymous `public/` namespace would let any anonymous caller read, overwrite, or delete every other anonymous caller's objects. Wire `resolveIdentity` into `createWorker` (see the `auth` registry item) so `ctx.auth.userId` is populated. If you genuinely want a public namespace, add a separate **read-only** public path — never point `deleteObject` / `generateUploadUrl` at a shared anonymous prefix.

## Verify downloads in your Worker

Signed URLs are only as good as the route that checks them. Gate `GET /storage/:key` with `verifySignedUrl` before streaming the R2 body. `@lunora/server` ships `serveStorageObject` to do exactly this, or wire it by hand:

```ts
// in your Worker entry
import { verifySignedUrl } from "@lunora/storage";

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/storage/")) {
            const result = await verifySignedUrl(url, env.STORAGE_SIGNING_SECRET);

            if (!result.valid || result.key === undefined) {
                // Expose only `valid` — a precise reason is a signing oracle.
                return new Response("forbidden", { status: 403 });
            }

            const object = await env.UPLOADS.get(result.key);

            if (!object) {
                return new Response("not found", { status: 404 });
            }

            return new Response(object.body, {
                headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
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

// 2. upload straight to R2 (no Worker proxy)
await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });

// 3. later, get a signed GET URL to display it
const { url: downloadUrl } = await client.action("storage/getDownloadUrl", { key: "avatar.png" });
```

`generateUploadUrl` / `getDownloadUrl` return the **scoped** key (`<userId>/avatar.png`) alongside the URL, so you can persist it in your own tables; pass the bare key (`"avatar.png"`) back in — the component re-scopes it for you.

## What you own

Everything under `lunora/storage/` is copied into your repo — change the tenancy prefix, the default TTLs, add a `maxSize` / `allowedContentTypes` guard on uploads, or add `download` / `getMetadata` functions from `@lunora/storage` however you like. `@lunora/storage` provides the R2 adapter + signing helpers; this component is the idiomatic Lunora glue around them.
