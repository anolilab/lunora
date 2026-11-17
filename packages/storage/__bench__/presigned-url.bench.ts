import { bench, describe } from "vitest";

import { buildPresignedUrl } from "../src/presigned-url";

/**
 * `ctx.storage.getPresignedUrl` runs once per object handed to a client, so a
 * listing that returns N downloadable files presigns N times. The SigV4 signing
 * key is an HMAC chain over (secret, date, region, service) — fixed for a whole
 * UTC day — so only the final HMAC over the string-to-sign varies per call.
 */

const credentials = {
    accessKeyId: "AKIAEXAMPLE",
    accountId: "acc123",
    bucket: "files",
    secretAccessKey: "bench-secret-access-key",
};
const now = (): number => Date.UTC(2026, 9, 27, 12, 0, 0);

describe("buildPresignedUrl", () => {
    bench("presign one GET", async () => {
        await buildPresignedUrl({ credentials, key: "uploads/photo.png", now });
    });
});
