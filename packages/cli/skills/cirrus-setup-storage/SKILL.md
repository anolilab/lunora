---
name: cirrus-setup-storage
description: Adds R2-backed file storage to a Cirrus app. Use for uploads/downloads via `cirrus registry add storage`, signed PUT/GET URLs, the `UPLOADS` R2 bucket binding, `STORAGE_SIGNING_SECRET`, per-tenant key scoping, and verifying downloads in the Worker.
---

# Cirrus Setup Storage

Wire R2-backed file storage into a Cirrus app using the `storage` registry item,
which is built on `@cirrus/storage` (an R2 adapter plus HMAC signed-URL helpers)
and exposes idiomatic Cirrus functions for direct browser uploads, gated
downloads, delete, and list — so the bytes never proxy through your Worker.

## When to Use

- Uploading user files (avatars, attachments) straight to R2.
- Serving private/gated downloads via short-lived signed URLs.
- Listing or deleting a caller's stored objects.

## When Not to Use

- The project has no Cirrus backend yet — use `cirrus-quickstart` first.
- Storage is already installed and you just want to upload — call
  `client.action("storage/generateUploadUrl", …)` and `PUT` to the returned URL.

## Workflow

1. Add the `storage` item.
2. Configure the `UPLOADS` R2 bucket binding and the signing secret.
3. Regenerate types with `cirrus codegen`.
4. Verify signed downloads in the Worker's `GET /storage/:key` route.
5. Upload/download from the client.

## Step 1: Add the item

```bash
cirrus registry add storage
```

This:

1. Adds `@cirrus/storage` and `@cirrus/server` to `package.json` (run
   `pnpm install` afterwards).
2. Adds an R2 bucket binding to `wrangler.jsonc` (`r2_buckets`, binding
   **`UPLOADS`**, `bucket_name: "REPLACE_ME-uploads"` — rename it to a real
   bucket). It **merges** into any existing `r2_buckets`.
3. Scaffolds `STORAGE_SIGNING_SECRET` (a secret) and `STORAGE_PUBLIC_BASE_URL`
   into `.dev.vars`.
4. Copies `cirrus/storage/index.ts` (the `generateUploadUrl` /
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
cirrus codegen
```

The functions surface in the generated `api` as `api.storage.generateUploadUrl`,
`api.storage.getDownloadUrl`, `api.storage.deleteObject`, and
`api.storage.listObjects`.

## Step 4: Verify downloads in the Worker

Signed URLs are only as safe as the route that checks them. Gate
`GET /storage/:key` with `verifySignedUrl` before streaming the R2 body
(`@cirrus/server` also ships `serveStorageObject` to do this):

```ts
import { verifySignedUrl } from "@cirrus/storage";

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

        // ... your Cirrus handler
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
2. **Placeholder bucket name.** `bucket_name: "REPLACE_ME-uploads"` ships as a
   placeholder — rename it to a real R2 bucket.
3. **Short / shared signing secret.** Use ≥32 chars and a distinct secret per
   bucket; reusing it lets one bucket's URLs sign for another.
4. **Proxying bytes through the Worker.** The design uploads/downloads directly
   to R2 via signed URLs — don't re-route the file body through a function.

## Checklist

- [ ] `cirrus registry add storage` run, `pnpm install` done.
- [ ] `UPLOADS` bucket bound to a real bucket; `STORAGE_SIGNING_SECRET` (≥32
      chars) and `STORAGE_PUBLIC_BASE_URL` set.
- [ ] `cirrus codegen` run so `api.storage.*` is generated.
- [ ] `GET /storage/:key` route verifies signed URLs before streaming.
- [ ] Verified a client upload → signed download round-trip.
