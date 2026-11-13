import { verifySignedUrl } from "./signed-url";

/**
 * Gate for a signed-download route: admits a GET request only when its URL is a GET
 * minted for the key the route resolved, in the bucket the route serves. The request's
 * own method is checked too, because a route mounted with `app.all(...)` passes any. A valid
 * signature alone is not enough: the same secret also signs PUT upload URLs, and
 * URLs for other buckets and other keys, so `verifySignedUrl(...).valid` admits
 * any of them.
 *
 * `expectedHost` is forwarded to `verifySignedUrl` for host-rewriting topologies
 * (see its docs); omit it when the request host is the minted host.
 */
// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export const authorizeSignedGet =
    (secret: string, options: { bucketName: string; expectedHost?: string }) =>
    async ({ key, request }: { key: string; request: Request }): Promise<boolean> => {
        if (request.method !== "GET") {
            return false;
        }

        const verdict =
            options.expectedHost === undefined
                ? await verifySignedUrl(new URL(request.url), secret)
                : await verifySignedUrl(new URL(request.url), secret, { expectedHost: options.expectedHost });

        return verdict.valid && verdict.method === "GET" && verdict.key === key && verdict.bucketName === options.bucketName;
    };
