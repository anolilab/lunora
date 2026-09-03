---
name: lunora-setup-storage
description: Adds R2-backed file storage to a Lunora app. Use for uploads/downloads via `lunora registry add storage`, signed PUT/GET URLs, the `UPLOADS` R2 bucket binding, `STORAGE_SIGNING_SECRET`, per-tenant key scoping, and verifying downloads in the Worker.
---

# Lunora Setup Storage

Wire R2-backed file storage into a Lunora app using the `storage` registry item,
which is built on `@lunora/storage` (an R2 adapter plus HMAC signed-URL helpers)
and exposes idiomatic Lunora functions for browser uploads, gated downloads,
delete, and list — with no bucket credential in the client.

A worker-signed URL points at **your Worker**, not at R2:
`${STORAGE_PUBLIC_BASE_URL}/<key>?exp&method&bucket&sig`. The `/storage/*` route
you add in step 4 is what verifies the signature and moves the bytes, for both
the upload and the download. (The no-Worker-in-the-path variant is
`@lunora/storage`'s S3 presigned URL, `getPresignedUrl` — it needs S3 credentials
on the bucket and enforces none of your rules.)

## When to Use

- Uploading user files (avatars, attachments) into R2 under your own gate.
- Serving private/gated downloads via short-lived signed URLs.
- Listing or deleting a caller's stored objects.

## When Not to Use

- The project has no Lunora backend yet — use `lunora-quickstart` first.
- Storage is already installed and you just want to upload — call
  `client.action("storage/generateUploadUrl", …)` and `PUT` to the returned URL.

## Workflow

1. Add the `storage` item.
2. Configure the `UPLOADS` R2 bucket binding and the signing secret.
3. Regenerate types with `lunora codegen`.
4. Add the `/storage/*` route to the Worker — it verifies signatures and serves
   both the signed `PUT` and the signed `GET`.
5. Upload/download from the client.

## Step 1: Add the item

```bash
lunora registry add storage
```

This:

1. Adds `@lunora/storage` and `@lunora/server` to `package.json` (run
   `pnpm install` afterwards).
2. Adds an R2 bucket binding to `wrangler.jsonc` (`r2_buckets`, binding
   **`UPLOADS`**, `bucket_name: "replace-me-uploads"` — rename it to a real
   bucket). It **merges** into any existing `r2_buckets`.
3. Scaffolds `STORAGE_SIGNING_SECRET` (a secret) and `STORAGE_PUBLIC_BASE_URL`
   into `.dev.vars`.
4. Copies `lunora/storage/index.ts` (the `generateUploadUrl` /
   `getDownloadUrl` / `deleteObject` / `listObjects` functions) into your
   project — it is **yours** to edit.

## Step 2: Configure the binding + secrets

| Name                      | Where                                | Notes                                                                                                                                  |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOADS`                 | `wrangler.jsonc` → `r2_buckets[]`    | The R2 bucket binding. Point `bucket_name` at a real bucket.                                                                           |
| `STORAGE_SIGNING_SECRET`  | secret (`.dev.vars` / `secret put`)  | HMAC secret for signed URLs. Min 32 chars, enforced — a shorter one throws on the first call. Never share across tenants.              |
| `STORAGE_PUBLIC_BASE_URL` | var (`.dev.vars` / `wrangler.jsonc`) | **Bare origin** running the `/storage/*` route (scaffolded `http://localhost:8787`). A base carrying a path is rejected by the signer. |

`STORAGE_PUBLIC_BASE_URL` must be `https://` anywhere but local dev. A signed URL
_is_ a bearer credential and the object bytes stream through it, so a plaintext
origin hands both to anyone on the path. Only `http://localhost` /
`http://127.0.0.1` belong in `.dev.vars`.

Generate a real signing secret with `openssl rand -base64 32` and write it with
`wrangler secret put STORAGE_SIGNING_SECRET` for production.

## Step 3: Regenerate types

```bash
lunora codegen
```

The functions surface in the generated `api` as `api.storage.generateUploadUrl`,
`api.storage.getDownloadUrl`, `api.storage.deleteObject`, and
`api.storage.listObjects`.

## Step 4: Add the `/storage/*` route to the Worker

**Required, not optional.** Without it a minted URL hits the Lunora catch-all and
every upload and download 404s — and it is the only thing checking the signature,
so skipping the check lets anyone read any key.

`@lunora/server`'s `serveStorageObject(ctx, key, request, authorize)` handles
the download half (`Range`/206, `ETag`, `nosniff`, and
`content-disposition: attachment` for anything outside a small inline-safe set —
raster images plus `audio/mpeg`, `audio/ogg`, `audio/wav`, `video/mp4`,
`video/webm`, with `image/svg+xml` deliberately excluded). It verifies nothing on
its own — its required `authorize` gate is where `verifySignedUrl` goes — and it
does not handle the upload. Reach for it from an `httpAction`, where `ctx.storage`
is in scope, whenever you want `Range` seeking or conditional requests.

The route below is the standalone version — a plain worker `fetch` with only the
R2 binding to hand, so it serves whole objects and skips `Range`/`ETag`. Both
verbs, by hand:

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

**Why the CORS lines are there.** If `STORAGE_PUBLIC_BASE_URL` is not your app's
own origin, the browser `PUT` below is preflighted (`PUT` is not a simple method,
and `content-type: image/png` is not a safelisted value). Answering `OPTIONS` is
only half of it: the browser also reads
`access-control-allow-origin` off the **real** response, so the 204 and the
download response carry `...cors` too — a route that answers only the preflight
passes it and then fails the request it was preflighting.

Keep `STORAGE_PUBLIC_BASE_URL` same-origin if you would rather not maintain an
allowlist; then `ALLOWED_ORIGINS` can be empty and `cors` never adds a header
beyond `vary: origin`.

`verifySignedUrl` checks expiry, then the HMAC. On a host-rewrite / CDN topology
pass `{ expectedHost }` (the `STORAGE_PUBLIC_BASE_URL` host) so the signature
canonicalizes against the host it was minted for.

## Step 5: Upload / download from the client

```ts
// 1. ask the server for a signed PUT URL
const { key, url } = await client.action("storage/generateUploadUrl", {
    key: "avatar.png",
    contentType: file.type,
});

// 2. upload it — the URL points at your Worker's `/storage/*` route, which
//    verifies the signature and writes to R2. The content type is pinned into
//    the signature (and carried on the URL as `&ct=`); that signed value is what
//    gets stored, so the request's own `content-type` header is not read and
//    cannot override it.
await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });

// 3. later, get a signed GET URL to display it
const { url: downloadUrl } = await client.action("storage/getDownloadUrl", { key: "avatar.png" });
```

Every key is scoped per-tenant with `scopeKey(requireOwner(ctx.auth.userId),
key)` — `requireOwner` returns `storage/<userId>` — so a client-supplied key can
never address another user's data, and the `storage/` prefix is what lands the
minted URL on the `/storage/*` route. The functions return the **scoped** key
(`storage/<userId>/avatar.png`) alongside the URL; persist that, and pass the
bare key back in — the component re-scopes it.

## Common Pitfalls

1. **Skipping `verifySignedUrl` on the download route.** Without it, anyone can
   read any key. Always verify before streaming.
2. **Placeholder bucket name.** `lunora init` and `lunora add storage` prompt for
   the bucket name (or take `--bucket <name>`), but the low-level
   `lunora registry add storage` writes the placeholder
   `bucket_name: "replace-me-uploads"` — rename it to a real R2 bucket. (R2 names
   are lowercase alphanumeric + hyphens, 3–63 chars; wrangler rejects anything
   else on `dev`/`deploy`.)
3. **Short / shared signing secret.** ≥32 chars is enforced (the item throws on
   the first call below it). Cross-_bucket_ replay is not a risk here — the
   bucket name is part of the HMAC canonical and rides on the URL as `&bucket=`,
   so a URL minted for one bucket never verifies against another under the same
   secret. Cross-_tenant_ reuse is the real hazard: one secret shared between two
   apps lets either mint URLs the other's route will honour, so keep a distinct
   secret per deployment.
4. **Base URL with a path.** `STORAGE_PUBLIC_BASE_URL` must be a bare origin. The
   key is verified from the whole URL pathname, so a subpath base would make
   every minted URL fail verification — `buildSignedUrl` rejects it up front.
5. **Routing the body through a Lunora function.** Uploads and downloads go
   through the thin `/storage/*` route, which streams to and from R2 — don't
   read the file into a `query`/`mutation`/`action` argument or return value.

## Checklist

- [ ] `lunora registry add storage` run, `pnpm install` done.
- [ ] `UPLOADS` bucket bound to a real bucket; `STORAGE_SIGNING_SECRET` (≥32
      chars) and `STORAGE_PUBLIC_BASE_URL` (a bare origin) set.
- [ ] `lunora codegen` run so `api.storage.*` is generated.
- [ ] `/storage/*` route added, verifying signed URLs on both `PUT` and `GET`.
- [ ] Verified a client upload → signed download round-trip.
