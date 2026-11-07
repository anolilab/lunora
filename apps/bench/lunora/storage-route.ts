/**
 * The `/storage/*` route signed upload / download URLs resolve to — the one
 * place their signature is checked (see the `storage` registry item's README).
 */
import type { R2BucketLike } from "@lunora/storage";
import { verifySignedUrl } from "@lunora/storage";

/** Cap what a single signed PUT may store. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Errors the body once it carries more bytes than `limit`, so a request cannot store more than the length it declared.
 */
const capBytes = (body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> => {
    let seen = 0;

    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                seen += chunk.byteLength;

                if (seen > limit) {
                    controller.error(new Error("body exceeds its declared length"));

                    return;
                }

                controller.enqueue(chunk);
            },
        }),
    );
};

/** The floor `lunora/storage` enforces when it signs; a shorter secret is brute-forceable, so nothing it "signed" is trusted. */
const MIN_SIGNING_SECRET_LENGTH = 32;

/**
 * The bucket name `lunora/storage` binds into every URL it mints. A URL signed for
 * another bucket under a shared secret must not reach `UPLOADS`.
 */
const SIGNED_BUCKET = "default";

export const serveStorage = async (request: Request, env: { STORAGE_SIGNING_SECRET?: string; UPLOADS: R2BucketLike }): Promise<Response> => {
    const url = new URL(request.url);

    // The verb is part of the signed payload; checked anyway so a GET URL is never replayed as a PUT.
    if (request.method !== (url.searchParams.get("method") ?? "GET")) {
        return new Response("method not allowed", { status: 405 });
    }

    const secret = env.STORAGE_SIGNING_SECRET;

    if (secret === undefined || secret.length < MIN_SIGNING_SECRET_LENGTH) {
        return new Response("storage is not configured", { status: 503 });
    }

    const result = await verifySignedUrl(url, secret);

    // Only `valid` is exposed: a precise reason is a signing oracle.
    if (!result.valid || result.key === undefined || result.bucketName !== SIGNED_BUCKET) {
        return new Response("forbidden", { status: 403 });
    }

    if (request.method === "PUT") {
        const length = Number(request.headers.get("content-length") ?? Number.NaN);

        // The signature pins the vetted content type; trusting the request's header would allow stored XSS.
        if (result.contentType === undefined || !Number.isFinite(length) || length > MAX_UPLOAD_BYTES) {
            return new Response("bad upload", { status: 400 });
        }

        if (request.body === null) {
            return new Response("bad upload", { status: 400 });
        }

        try {
            await env.UPLOADS.put(result.key, capBytes(request.body, length), { httpMetadata: { contentType: result.contentType } });
        } catch {
            // The stream errors once it carries more bytes than its declared length; nothing partial is kept.
            return new Response("upload exceeds its declared length", { status: 413 });
        }

        // eslint-disable-next-line unicorn/no-null -- a 204 must carry no body, and `Response` takes `null` for that
        return new Response(null, { status: 204 });
    }

    const object = await env.UPLOADS.get(result.key);

    if (!object) {
        return new Response("not found", { status: 404 });
    }

    return new Response(object.body as BodyInit, {
        headers: {
            "content-disposition": "attachment",
            "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "x-content-type-options": "nosniff",
        },
    });
};
