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
    /** PR head commit — the server-side preview build target (GAPS.md A3). */
    commitSha?: string;
    installationId?: number;
    number: number;
    repository: string;
}

interface PullRequestPayload {
    action?: string;
    installation?: { id?: number };
    number?: number;
    pull_request?: { head?: { ref?: string; sha?: string } };
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
    const commitSha = event.pull_request?.head?.sha;
    const installationId = event.installation?.id;
    const repository = event.repository?.full_name;
    const { action, number } = event;

    if (typeof branch !== "string" || typeof number !== "number" || typeof repository !== "string") {
        return null;
    }

    if (action === "opened" || action === "synchronize" || action === "reopened") {
        return { action: "upsert", branch, commitSha, installationId, number, repository };
    }

    if (action === "closed") {
        return { action: "remove", branch, number, repository };
    }

    return null;
};

export interface PushIntent {
    branch: string;
    commitSha: string;
    installationId: number;
    repository: string;
}

interface PushPayload {
    after?: string;
    installation?: { id?: number };
    ref?: string;
    repository?: { default_branch?: string; full_name?: string };
}

const ZERO_SHA = /^0+$/u;

/**
 * Map a `push` webhook payload to a build intent (GAPS.md A4), or `null` when
 * irrelevant: only pushes to the repository's default branch build (Zeitwork's
 * rule), and branch-delete pushes (zero SHA) are ignored.
 */
export const parsePushEvent = (payload: unknown): null | PushIntent => {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const event = payload as PushPayload;
    const repository = event.repository?.full_name;
    const defaultBranch = event.repository?.default_branch ?? "main";
    const commitSha = event.after;
    const installationId = event.installation?.id;

    if (typeof repository !== "string" || typeof commitSha !== "string" || typeof installationId !== "number" || event.ref !== `refs/heads/${defaultBranch}`) {
        return null;
    }

    if (ZERO_SHA.test(commitSha)) {
        return null;
    }

    return { branch: defaultBranch, commitSha, installationId, repository };
};

export interface InstallationIntent {
    accountLogin: string;
    action: "created" | "deleted";
    installationId: number;
}

interface InstallationPayload {
    action?: string;
    installation?: { account?: { login?: string }; id?: number };
}

/** Map an `installation` webhook payload to a link/unlink intent (GAPS.md A4), or `null`. */
export const parseInstallationEvent = (payload: unknown): InstallationIntent | null => {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const event = payload as InstallationPayload;
    const installationId = event.installation?.id;
    const accountLogin = event.installation?.account?.login;

    if (typeof installationId !== "number" || typeof accountLogin !== "string") {
        return null;
    }

    if (event.action === "created" || event.action === "deleted") {
        return { accountLogin, action: event.action, installationId };
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
export interface GitHubWebhookHooks {
    /** Link/unlink a GitHub App installation (`installation` events, GAPS.md A4). */
    onInstallation?: (intent: InstallationIntent) => Promise<void>;
    /** Record a server-side preview build for a PR head (upsert events, GAPS.md A3). */
    onPreviewBuild?: (intent: {
        branch: string;
        commitSha: string;
        installationId: number;
        repository: string;
    }) => Promise<null | { buildId: string; reused: boolean }>;
    /** Record a build for a default-branch push (`push` events, GAPS.md A4). Returns the build id or null when the repo isn't connected. */
    onPush?: (intent: PushIntent) => Promise<null | { buildId: string; reused: boolean }>;
    resolveProject: ResolveProject;
    secret: string;
}

/** Handle a parsed PR intent: resolve the project, optionally queue a preview build, acknowledge. */
const handlePullRequestIntent = async (intent: PreviewIntent, options: GitHubWebhookHooks): Promise<Response> => {
    const project = await options.resolveProject(intent.repository);

    if (!project) {
        return Response.json({ ignored: true, reason: "repository not connected to a project" }, { status: 202 });
    }

    // Server-side preview build (GAPS.md A3): a PR upsert with a known head
    // commit + installation queues a build just like a default-branch push.
    let previewBuild: null | { buildId: string; reused: boolean } = null;

    if (intent.action === "upsert" && intent.commitSha && intent.installationId !== undefined && options.onPreviewBuild) {
        previewBuild = await options.onPreviewBuild({
            branch: intent.branch,
            commitSha: intent.commitSha,
            installationId: intent.installationId,
            repository: intent.repository,
        });
    }

    return Response.json(
        {
            accepted: true,
            intent,
            ...(previewBuild ? { previewBuild } : {}),
            previewScriptName: previewScriptName(project.slug, intent.branch),
            projectId: project.projectId, // secret-scanner:allow -- domain field name
        },
        { status: 200 },
    );
};

export const handleGitHubWebhook = async (request: Request, options: GitHubWebhookHooks): Promise<Response> => {
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

    const eventName = request.headers.get("x-github-event");

    if (eventName === "installation" && options.onInstallation) {
        const installation = parseInstallationEvent(payload);

        if (!installation) {
            return Response.json({ ignored: true }, { status: 202 });
        }

        await options.onInstallation(installation);

        return Response.json({ accepted: true, installation: installation.action }, { status: 200 });
    }

    if (eventName === "push" && options.onPush) {
        const push = parsePushEvent(payload);

        if (!push) {
            return Response.json({ ignored: true }, { status: 202 });
        }

        const build = await options.onPush(push);

        if (!build) {
            return Response.json({ ignored: true, reason: "repository not connected to a project" }, { status: 202 });
        }

        return Response.json({ accepted: true, ...build }, { status: 200 });
    }

    const intent = parsePullRequestEvent(payload);

    if (!intent) {
        return Response.json({ ignored: true }, { status: 202 });
    }

    return handlePullRequestIntent(intent, options);
};
