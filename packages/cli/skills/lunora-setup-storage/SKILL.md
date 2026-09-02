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
| `STORAGE_SIGNING_SECRET`  | secret (`.dev.vars` / `secret put`)  | HMAC secret for signed URLs. Min 32 chars, enforced — a shorter one throws on the first call. Never share across buckets.              |
| `STORAGE_PUBLIC_BASE_URL` | var (`.dev.vars` / `wrangler.jsonc`) | **Bare origin** running the `/storage/*` route (scaffolded `http://localhost:8787`). A base carrying a path is rejected by the signer. |

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

`@lunora/server`'s `serveStorageObject(ctx, key, request, { authorize })` handles
the download half (`Range`/206, `ETag`, `nosniff`, and
`content-disposition: attachment` for anything outside a small inline-safe set —
raster images plus `audio/mpeg`, `audio/ogg`, `audio/wav`, `video/mp4`,
`video/webm`, with `image/svg+xml` deliberately excluded). It verifies nothing on
its own — its required `authorize` gate is where `verifySignedUrl` goes — and it
does not handle the upload. Both verbs, by hand:

```ts
import { verifySignedUrl } from "@lunora/storage";

/** Cap what a single signed PUT may store. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/storage/")) {
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
//    verifies the signature and writes to R2. The `content-type` must match the
//    one pinned into the signature or verification fails.
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
   the first call below it); a distinct secret per bucket is not — reusing one
   lets a bucket's URLs sign for another.
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
