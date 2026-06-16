/**
 * GitHub webhook handling for preview deployments (CLOUD-PLAN.md §2.3 / Phase 2).
 * A PR opened/updated → upsert a preview for its branch; a PR closed → tear the
 * preview down. Signatures are verified with the webhook secret (HMAC-SHA256).
 */

import { previewScriptName } from "../deploy/preview";

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

/** Resolves a connected GitHub repository to its Lunora project. */
export type ResolveProject = (repository: string) => Promise<null | { organizationId: string; projectId: string; slug: string }>; // secret-scanner:allow -- domain field name

/**
 * HTTP handler for the GitHub webhook endpoint (`POST /v1/github/webhook`).
 * Verifies the signature, parses the PR event, resolves the connected project,
 * and returns the preview intent enriched with the resolved project + the
 * deterministic preview script id.
 *
 * The deploy itself runs from CI via `POST /v1/deploy` with a preview deploy key
 * (CI holds it); previews tear down via their TTL cron (§2.3). So this endpoint's
 * job is project resolution + acknowledgement, not minting cross-org deploys.
 */
export const handleGitHubWebhook = async (request: Request, options: { resolveProject: ResolveProject; secret: string }): Promise<Response> => {
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

    const project = await options.resolveProject(intent.repository);

    if (!project) {
        return Response.json({ ignored: true, reason: "repository not connected to a project" }, { status: 202 });
    }

    return Response.json(
        {
            accepted: true,
            intent,
            previewScriptName: previewScriptName(project.slug, intent.branch),
            projectId: project.projectId, // secret-scanner:allow -- domain field name
        },
        { status: 200 },
    );
};
