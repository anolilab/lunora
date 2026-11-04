import { readBodyTextCapped } from "../../../shared/read-body-text-capped";

/**
 * The largest webhook body {@link readWebhookBody} accepts: 1 MiB, the same cap
 * the runtime puts on its own planes. Provider events are a few KiB; anything
 * near this is not one.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/**
 * Read a webhook's raw body, or `undefined` when it is larger than `maxBytes`.
 *
 * The endpoint is public and the signature can only be checked once the body is
 * in hand, so an unbounded `request.text()` lets any caller make the Worker
 * buffer as much as it sends. A declared `Content-Length` over the cap is
 * refused without reading; since the header is forgeable (a chunked request has
 * none), the cap is also enforced while the bytes arrive. Answer `undefined`
 * with a 413.
 */
export const readWebhookBody = async (request: Request, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<string | undefined> => {
    const declared = Number(request.headers.get("content-length") ?? "");

    if (Number.isFinite(declared) && declared > maxBytes) {
        return undefined;
    }

    return (await readBodyTextCapped(request, maxBytes)) ?? undefined;
};
