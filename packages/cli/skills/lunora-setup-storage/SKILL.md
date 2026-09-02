---
name: lunora-setup-storage
description: Adds R2-backed file storage to a Lunora app. Use for uploads/downloads via `lunora registry add storage`, signed PUT/GET URLs, the `UPLOADS` R2 bucket binding, `STORAGE_SIGNING_SECRET`, per-tenant key scoping, and verifying downloads in the Worker.
---

# Lunora Setup Storage

Wire R2-backed file storage into a Lunora app using the `storage` registry item,
which is built on `@lunora/storage` (an R2 adapter plus HMAC signed-URL helpers)
and exposes idiomatic Lunora functions for direct browser uploads, gated
downloads, delete, and list — so the bytes never proxy through your Worker.

## When to Use

- Uploading user files (avatars, attachments) straight to R2.
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
4. Verify signed downloads in the Worker's `GET /storage/:key` route.
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

| Name                      | Where                                | Notes                                                                    |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `UPLOADS`                 | `wrangler.jsonc` → `r2_buckets[]`    | The R2 bucket binding. Point `bucket_name` at a real bucket.             |
| `STORAGE_SIGNING_SECRET`  | secret (`.dev.vars` / `secret put`)  | HMAC secret for signed URLs. Min 32 chars; never share across buckets.   |
| `STORAGE_PUBLIC_BASE_URL` | var (`.dev.vars` / `wrangler.jsonc`) | Public host/route that fronts the bucket and serves `GET /storage/:key`. |

Generate a real signing secret with `openssl rand -base64 32` and write it with
`wrangler secret put STORAGE_SIGNING_SECRET` for production.

## Step 3: Regenerate types

```bash
lunora codegen
```

The functions surface in the generated `api` as `api.storage.generateUploadUrl`,
`api.storage.getDownloadUrl`, `api.storage.deleteObject`, and
`api.storage.listObjects`.

## Step 4: Verify downloads in the Worker

Signed URLs are only as safe as the route that checks them. Gate
`GET /storage/:key` with `verifySignedUrl` before streaming the R2 body.

`@lunora/server`'s `serveStorageObject(ctx, key, request, { authorize })` handles
the streaming half (`Range`/206, `ETag`, `nosniff`, and
`content-disposition: attachment` for anything but a raster image) but verifies
nothing on its own — its required `authorize` gate is where `verifySignedUrl`
goes. Or wire it by hand:

```ts
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

// 2. upload straight to R2 (no Worker proxy)
await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });

// 3. later, get a signed GET URL to display it
const { url: downloadUrl } = await client.action("storage/getDownloadUrl", { key: "avatar.png" });
```

Every key is scoped per-tenant with `scopeKey(tenantPrefix(ctx.auth.userId),
key)`, so a client-supplied key can never address another user's data. The
functions return the **scoped** key (`<userId>/avatar.png`) alongside the URL;
persist that, and pass the bare key back in — the component re-scopes it.

## Common Pitfalls

1. **Skipping `verifySignedUrl` on the download route.** Without it, anyone can
   read any key. Always verify before streaming.
2. **Placeholder bucket name.** `lunora init` and `lunora add storage` prompt for
   the bucket name (or take `--bucket <name>`), but the low-level
   `lunora registry add storage` writes the placeholder
   `bucket_name: "replace-me-uploads"` — rename it to a real R2 bucket. (R2 names
   are lowercase alphanumeric + hyphens, 3–63 chars; wrangler rejects anything
   else on `dev`/`deploy`.)
3. **Short / shared signing secret.** Use ≥32 chars and a distinct secret per
   bucket; reusing it lets one bucket's URLs sign for another.
4. **Proxying bytes through the Worker.** The design uploads/downloads directly
   to R2 via signed URLs — don't re-route the file body through a function.

## Checklist

- [ ] `lunora registry add storage` run, `pnpm install` done.
- [ ] `UPLOADS` bucket bound to a real bucket; `STORAGE_SIGNING_SECRET` (≥32
      chars) and `STORAGE_PUBLIC_BASE_URL` set.
- [ ] `lunora codegen` run so `api.storage.*` is generated.
- [ ] `GET /storage/:key` route verifies signed URLs before streaming.
- [ ] Verified a client upload → signed download round-trip.
