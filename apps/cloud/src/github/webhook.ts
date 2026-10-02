/**
 * GitHub webhook handling for preview deployments.
 * A PR opened/updated → upsert a preview for its branch; a PR closed → tear the
 * preview down. Signatures are verified with the webhook secret (HMAC-SHA256).
 */

import type { PushChanges } from "../builds/paths";
import { MAX_CHANGED_FILES } from "../builds/paths";
import { forkPreviewScriptName, previewScriptName } from "../deploy/preview";
import { constantTimeEqual } from "../security/constant-time-equal";

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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

    return constantTimeEqual(`sha256=${toHex(signature)}`, signatureHeader);
};

export interface PreviewIntent {
    /** `upsert` for opened/synchronize/reopened; `remove` for closed/merged. */
    action: "remove" | "upsert";
    /** PR base commit — the other end of the diff the preview path filter reads. */
    baseSha?: string;
    branch: string;
    /** PR head commit — the server-side preview build target (GAPS.md A3). */
    commitSha?: string;

    /**
     * The PR's head lives in another repository (a fork). Set on `upsert` only.
     * A fork's code is built but never released: a preview release resolves the
     * project's preview secrets and mints its ingest key, which an outside
     * contributor must never be able to reach by opening a pull request.
     */
    fromFork?: boolean;
    installationId?: number;
    number: number;
    repository: string;
}

interface PullRequestPayload {
    action?: string;
    installation?: { id?: number };
    number?: number;
    pull_request?: { base?: { sha?: string }; head?: { ref?: string; repo?: null | { full_name?: string }; sha?: string } };
    repository?: { full_name?: string };
}

/**
 * Does the PR's head live outside the base repository?
 *
 * Fails closed: GitHub sends `head.repo: null` when the fork was deleted, and a
 * payload with no head repository at all proves nothing — both count as a fork.
 * Compared case-insensitively, as GitHub resolves repository names.
 */
const isForkHead = (event: PullRequestPayload, repository: string): boolean => {
    const headRepository = event.pull_request?.head?.repo?.full_name;

    return typeof headRepository !== "string" || headRepository.toLowerCase() !== repository.toLowerCase();
};

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
    const baseSha = event.pull_request?.base?.sha;
    const installationId = event.installation?.id;
    const repository = event.repository?.full_name;
    const { action, number } = event;

    if (typeof branch !== "string" || typeof number !== "number" || typeof repository !== "string") {
        return null;
    }

    if (action === "opened" || action === "synchronize" || action === "reopened") {
        return { action: "upsert", baseSha, branch, commitSha, fromFork: isForkHead(event, repository), installationId, number, repository };
    }

    if (action === "closed") {
        return { action: "remove", branch, number, repository };
    }

    return null;
};

export interface PushIntent {
    branch: string;
    /** The files the push changed, or why the payload cannot say — the path filter's input. */
    changes: PushChanges;
    commitSha: string;
    installationId: number;
    repository: string;
}

interface PushPayload {
    after?: string;
    before?: string;
    commits?: { added?: unknown; modified?: unknown; removed?: unknown }[];
    created?: boolean;
    forced?: boolean;
    installation?: { id?: number };
    ref?: string;
    repository?: { default_branch?: string; full_name?: string };
}

const ZERO_SHA = /^0+$/u;

/**
 * GitHub caps `commits` in a push payload (20 on the events path, and large
 * pushes arrive with the list cut short). A list this long may be incomplete,
 * so it proves nothing about the files that are NOT in it.
 */
const MAX_TRUSTED_COMMITS = 20;

/**
 * The files a push changed, or the reason the payload cannot prove it.
 *
 * Every doubt resolves to `unknown`, which builds: a forced push rewrote
 * history the commit list does not describe, a new branch's `commits` is
 * relative to nothing, and a truncated or malformed list omits files by
 * construction. Only a complete, well-formed list is allowed to skip a deploy.
 */
export const pushChanges = (event: PushPayload): PushChanges => {
    if (event.forced === true) {
        return { unknown: "forced push" };
    }

    if (event.created === true || (typeof event.before === "string" && ZERO_SHA.test(event.before))) {
        return { unknown: "new branch" };
    }

    const { commits } = event;

    if (!Array.isArray(commits) || commits.length === 0) {
        return { unknown: "the push lists no commits" };
    }

    if (commits.length >= MAX_TRUSTED_COMMITS) {
        return { unknown: `the push lists ${String(commits.length)} commits and may be truncated` };
    }

    const files = new Set<string>();

    for (const commit of commits) {
        for (const list of [commit.added, commit.modified, commit.removed]) {
            if (!Array.isArray(list) || list.some((file) => typeof file !== "string")) {
                return { unknown: "a commit is missing its file lists" };
            }

            for (const file of list as string[]) {
                files.add(file);
            }
        }
    }

    if (files.size > MAX_CHANGED_FILES) {
        return { unknown: `the push changed more than ${String(MAX_CHANGED_FILES)} files` };
    }

    return { files: [...files] };
};

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

    return { branch: defaultBranch, changes: pushChanges(event), commitSha, installationId, repository };
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

/** What recording a build returns: `null` for an unconnected repo; `skipped` when the path filter matched nothing. */
export type BuildRecordResult = null | { buildId: string; reused: boolean; skipped?: string };

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
    /** Record a server-side preview build for a PR head (upsert events, GAPS.md A3). */

    /**
     * List the files a PR changes (`base...head`) for the preview path filter.
     * Absent — no App credentials — previews build unfiltered.
     */
    listChangedFiles?: (range: { base: string; head: string; installationId: number; repository: string }) => Promise<PushChanges>;
    /** Link/unlink a GitHub App installation (`installation` events, GAPS.md A4). */
    onInstallation?: (intent: InstallationIntent) => Promise<void>;
    onPreviewBuild?: (intent: {
        branch: string;
        changes: PushChanges;
        commitSha: string;
        /** The head is a fork's: built, never released (see {@link PreviewIntent.fromFork}). */
        fromFork: boolean;
        installationId: number;
        /** The pull request number, which names a fork's preview. */
        pullRequest: number;
        repository: string;
    }) => Promise<BuildRecordResult>;
    /** Record a build for a default-branch push (`push` events, GAPS.md A4). Returns the build id or null when the repo isn't connected. */
    onPush?: (intent: PushIntent) => Promise<BuildRecordResult>;
    resolveProject: ResolveProject;
    secret: string;
}

/**
 * The files a PR changes, for the preview path filter. A `pull_request`
 * payload lists none, so they come from GitHub's compare API — and any failure
 * there degrades to `unknown`, which builds, exactly like an unprovable push.
 */
const previewChanges = async (intent: PreviewIntent & { commitSha: string; installationId: number }, options: GitHubWebhookHooks): Promise<PushChanges> => {
    if (intent.baseSha === undefined) {
        return { unknown: "the pull request payload has no base commit" };
    }

    if (!options.listChangedFiles) {
        return { unknown: "the control plane cannot list pull request files (no GitHub App credentials)" };
    }

    try {
        return await options.listChangedFiles({
            base: intent.baseSha,
            head: intent.commitSha,
            installationId: intent.installationId,
            repository: intent.repository,
        });
    } catch (error) {
        return { unknown: `listing the pull request's files failed: ${error instanceof Error ? error.message : String(error)}` };
    }
};

/** Handle a parsed PR intent: resolve the project, optionally queue a preview build, acknowledge. */
const handlePullRequestIntent = async (intent: PreviewIntent, options: GitHubWebhookHooks): Promise<Response> => {
    const project = await options.resolveProject(intent.repository);

    if (!project) {
        return Response.json({ ignored: true, reason: "repository not connected to a project" }, { status: 202 });
    }

    // Server-side preview build (GAPS.md A3): a PR upsert with a known head
    // commit + installation queues a build just like a default-branch push.
    let previewBuild: BuildRecordResult = null;

    if (intent.action === "upsert" && intent.commitSha && intent.installationId !== undefined && options.onPreviewBuild) {
        previewBuild = await options.onPreviewBuild({
            branch: intent.branch,
            changes: await previewChanges({ ...intent, commitSha: intent.commitSha, installationId: intent.installationId }, options),
            commitSha: intent.commitSha,
            fromFork: intent.fromFork !== false,
            installationId: intent.installationId,
            pullRequest: intent.number,
            repository: intent.repository,
        });
    }

    return Response.json(
        {
            accepted: true,
            intent,
            ...(previewBuild ? { previewBuild } : {}),
            previewScriptName: intent.fromFork === true ? forkPreviewScriptName(project.slug, intent.number) : previewScriptName(project.slug, intent.branch),
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
