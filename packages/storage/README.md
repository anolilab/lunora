# @cirrus/storage

R2 file storage adapter for the Cirrus framework. Wraps a Cloudflare `R2Bucket` binding with a small typed API (`upload`, `download`, `delete`, `list`) and a worker-signed-URL helper for gated `GET /storage/:key` endpoints.

```ts
import { createStorage, verifySignedUrl } from "@cirrus/storage";

const storage = createStorage({
    bucket: env.UPLOADS,
    publicBaseUrl: "https://cdn.acme.test",
    signingSecret: env.STORAGE_SIGNING_SECRET,
});

const url = await storage.getSignedUrl("uploads/avatar.png", { expiresInSeconds: 600 });
```

## Worker-signed URLs vs. native S3 presigned URLs

The signed URLs here resolve back through **your Worker** (`publicBaseUrl` → `GET /storage/:key`), not directly to R2. That's deliberate: a request for a worker-signed URL still passes your app's gates — auth/session checks, per-object policy, rate limits, audit logging — before the Worker validates the signature/expiry and streams the R2 body. **App-gating is the point.** The trade-off is that object bytes flow through the Worker rather than straight off R2.

R2 also supports **native S3 presigned URLs** (a self-contained bearer credential the client uses to hit R2's S3 endpoint directly, bypassing the Worker). Prefer those for large downloads or when you don't need per-request app logic. Cirrus does not wrap that path yet — use the R2 binding / S3 API directly. The same applies to R2 **multipart upload** for very large objects: not wrapped here; use the binding directly.

v0.1 ships worker-signed URLs (HMAC-SHA256). v0.2 will add presigned S3-compat URLs when an `accessKeyId/secretAccessKey` pair is provided.
