# @cirrus/storage

R2 file storage adapter for the Cirrus framework. Wraps a Cloudflare `R2Bucket` binding with a small typed API (`upload`, `download`, `delete`, `list`, multipart), a worker-signed-URL helper for gated `GET /storage/:key` endpoints, and native S3 presigned URLs for direct-to-R2 transfer.

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

R2 also supports **native S3 presigned URLs** (a self-contained credential the client uses to hit R2's S3 endpoint directly, bypassing the Worker). Prefer those for large downloads/uploads or when you don't need per-request app logic and want the bytes off the Worker's CPU/bandwidth budget. Pass R2 S3 credentials and call `getPresignedUrl`:

```ts
const storage = createStorage({
    bucket: env.UPLOADS,
    s3: {
        accountId: env.CF_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: "uploads",
    },
});

// A direct-to-R2 download URL (SigV4, no Worker round-trip):
const getUrl = await storage.getPresignedUrl("uploads/big.zip", { expiresInSeconds: 3600 });

// A direct-to-R2 upload URL:
const putUrl = await storage.getPresignedUrl("uploads/big.zip", { method: "PUT", expiresInSeconds: 600 });
```

The `s3` credentials are an **R2 API token's** Access Key ID / Secret Access Key (not a Cloudflare API token). The signature is computed with WebCrypto — no AWS SDK dependency. Without `s3`, `getPresignedUrl` throws; the worker-signed path needs none of this.

## Multipart upload (very large objects)

For objects too large for a single `PUT`, use native R2 multipart — upload uniform-size parts, then `complete` (or `abort`):

```ts
const upload = await storage.createMultipartUpload("uploads/video.mp4", { contentType: "video/mp4" });

const part1 = await upload.uploadPart(1, chunk1);
const part2 = await upload.uploadPart(2, chunk2);

await upload.complete([part1, part2]);
// Resume across requests with: storage.resumeMultipartUpload(key, upload.uploadId)
```

These wrap the R2 binding's multipart API directly; they throw if the bound bucket doesn't expose it.

v0.1 shipped worker-signed URLs (HMAC-SHA256); native S3 presigned URLs and multipart upload are now available too (see above).
