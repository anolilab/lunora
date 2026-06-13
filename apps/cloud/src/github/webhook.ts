/**
 * GitHub webhook handling for preview deployments (CLOUD-PLAN.md §2.3 / Phase 2).
 * A PR opened/updated → upsert a preview for its branch; a PR closed → tear the
 * preview down. Signatures are verified with the webhook secret (HMAC-SHA256).
 */

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time string compare (avoids leaking how much of a signature matched). */
const timingSafeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let mismatch = 0;

    for (let index = 0; index < a.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- constant-time comparison requires bitwise accumulation
        mismatch |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
    }

    return mismatch === 0;
};

/**
 * Verify a GitHub `x-hub-signature-256` header (`sha256=&lt;hex>`) against the raw
 * request body using the configured webhook secret.
 */
export const verifyGitHubSignature = async (secret: string, body: string, signatureHeader: null | string): Promise<boolean> => {
    if (!signatureHeader?.startsWith("sha256=")) {
        return false;
    }

    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

    return timingSafeEqual(`sha256=${toHex(signature)}`, signatureHeader);
};

export interface PreviewIntent {
    /** `upsert` for opened/synchronize/reopened; `remove` for closed/merged. */
    action: "remove" | "upsert";
    branch: string;
    number: number;
    repository: string;
}

interface PullRequestPayload {
    action?: string;
    number?: number;
    pull_request?: { head?: { ref?: string } };
    repository?: { full_name?: string };
}

/**
 * Map a `pull_request` webhook payload to a preview intent, or `null` if the
 * event is irrelevant or malformed.
 */
export const parsePullRequestEvent = (payload: unknown): null | PreviewIntent => {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const event = payload as PullRequestPayload;
    const branch = event.pull_request?.head?.ref;
    const repository = event.repository?.full_name;
    const { action, number } = event;

    if (typeof branch !== "string" || typeof number !== "number" || typeof repository !== "string") {
        return null;
    }

    if (action === "opened" || action === "synchronize" || action === "reopened") {
        return { action: "upsert", branch, number, repository };
    }

    if (action === "closed") {
        return { action: "remove", branch, number, repository };
    }

    return null;
};

/**
 * HTTP handler for the GitHub webhook endpoint (`POST /v1/github/webhook`).
 * Verifies the signature, parses the PR event, and acknowledges the resulting
 * preview intent.
 *
 * Triggering the preview deploy/teardown from here additionally needs a
 * repository→project link and a stored automation credential (the deploy
 * request has no user session) — a bounded follow-up; the verified, parsed
 * intent is returned so that wiring has a tested entry point.
 */
export const handleGitHubWebhook = async (request: Request, options: { secret: string }): Promise<Response> => {
    const body = await request.text();

    if (!(await verifyGitHubSignature(options.secret, body, request.headers.get("x-hub-signature-256")))) {
        return Response.json({ error: "invalid signature" }, { status: 401 });
    }

    let payload: unknown;

    try {
        payload = JSON.parse(body);
    } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const intent = parsePullRequestEvent(payload);

    if (!intent) {
        return Response.json({ ignored: true }, { status: 202 });
    }

    return Response.json({ accepted: true, intent }, { status: 200 });
};
