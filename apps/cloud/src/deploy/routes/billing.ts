import { api } from "../../../lunora/_generated/api";
import { LIMITS } from "../../../lunora/validators";
import { declaresOver, readCappedBytes } from "../../lib/read-capped-bytes";
import type { RouterEnv } from "./shared";
import { requireContext } from "./shared";

/**
 * The most bytes a body within the action's character limit can take: a UTF-16
 * code unit encodes to at most three UTF-8 bytes, so this never refuses a body
 * the action would accept.
 */
const MAX_WEBHOOK_BYTES = LIMITS.webhookBody * 3;

/**
 * `POST /v1/billing/webhook` — provider (Creem, the Merchant of Record) billing
 * webhook (§4). Reads the
 * raw body + signature and forwards them to the signature-verifying action so
 * the verification + store write happen where `ctx.payments` exists.
 */
export const handleBillingWebhookRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const tooLarge = Response.json({ error: `request body exceeds ${String(MAX_WEBHOOK_BYTES)} bytes` }, { status: 413 });

    if (declaresOver(request, MAX_WEBHOOK_BYTES)) {
        return tooLarge;
    }

    // Capped while it streams: the body is unauthenticated until the action verifies it, and a chunked one declares no length.
    const bytes = await readCappedBytes(request.body, MAX_WEBHOOK_BYTES);

    if (bytes === undefined) {
        return tooLarge;
    }

    const body = new TextDecoder().decode(bytes);
    const signature = request.headers.get("creem-signature") ?? "";
    const result = await context.runAction<{ applied: boolean; status: number }>(api.billing.processWebhook, { body, signature });

    return Response.json({ applied: result.applied }, { status: result.status });
};
