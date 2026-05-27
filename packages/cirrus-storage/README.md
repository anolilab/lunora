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

v0.1 ships worker-signed URLs (HMAC-SHA256). v0.2 will add presigned S3-compat URLs when an `accessKeyId/secretAccessKey` pair is provided.
