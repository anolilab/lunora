import { LunoraError } from "@lunora/errors";

import { readBodyTextCapped } from "../../../shared/read-body-text-capped";

/**
 * The largest webhook body {@link readWebhookBody} accepts: 1 MiB, the cap the
 * runtime puts on its own planes (`MAX_BODY_BYTES` in `@lunora/runtime`, which
 * this package does not depend on). Provider events are a few KiB.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/**
 * Read a webhook's raw body, throwing `PAYLOAD_TOO_LARGE` (413) past `maxBytes`.
 *
 * The endpoint is public and the signature can only be checked once the body is
 * in hand, so an unbounded `request.text()` lets any caller make the Worker
 * buffer as much as it sends. A declared `Content-Length` over the cap is
 * refused without reading; since the header is forgeable (a chunked request has
 * none), the cap is also enforced while the bytes arrive. An `httpAction`
 * answers the thrown error with its 413, so a route needs no branch.
 */
export const readWebhookBody = async (request: Request, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<string> => {
    const tooLarge = (): LunoraError => new LunoraError("PAYLOAD_TOO_LARGE", `webhook body over ${String(maxBytes)} bytes`);
    const declared = Number(request.headers.get("content-length") ?? "");

    if (Number.isFinite(declared) && declared > maxBytes) {
        throw tooLarge();
    }

    const body = await readBodyTextCapped(request, maxBytes);

    if (body === null) {
        throw tooLarge();
    }

    return body;
};
