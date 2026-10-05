import { describe, expect, it } from "vitest";

import type { PushChanges } from "../src/builds/paths";
import { handleGitHubWebhook, parsePullRequestEvent, pushChanges, verifyGitHubSignature } from "../src/github/webhook";

const sign = async (secret: string, body: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `sha256=${hex}`;
};

describe(verifyGitHubSignature, () => {
    it("accepts a correct signature and rejects tampering", async () => {
        const body = JSON.stringify({ action: "opened" });
        const signature = await sign("s3cret", body);

        await expect(verifyGitHubSignature("s3cret", body, signature)).resolves.toBe(true);
        await expect(verifyGitHubSignature("wrong", body, signature)).resolves.toBe(false);
        await expect(verifyGitHubSignature("s3cret", `${body} `, signature)).resolves.toBe(false);
    });

    it("rejects a missing or malformed header", async () => {
        await expect(verifyGitHubSignature("s", "b", null)).resolves.toBe(false);
        await expect(verifyGitHubSignature("s", "b", "deadbeef")).resolves.toBe(false);
    });
});

describe(parsePullRequestEvent, () => {
    const payload = (action: string) => {
        return { action, number: 7, pull_request: { head: { ref: "feat/x", repo: { full_name: "acme/app" } } }, repository: { full_name: "acme/app" } };
    };

    it("maps opened/synchronize/reopened to upsert", () => {
        for (const action of ["opened", "synchronize", "reopened"]) {
            expect(parsePullRequestEvent(payload(action))).toMatchObject({
                action: "upsert",
                branch: "feat/x",
                fromFork: false,
                number: 7,
                repository: "acme/app",
            });
        }
    });

    it("marks a pull request whose head is another repository's as a fork", () => {
        const fork = {
            action: "opened",
            number: 7,
            pull_request: { head: { ref: "main", repo: { full_name: "mallory/app" } } },
            repository: { full_name: "acme/app" },
        };

        expect(parsePullRequestEvent(fork)).toMatchObject({ action: "upsert", fromFork: true });
    });

    it("fails closed: a deleted or missing head repository counts as a fork", () => {
        const deleted = { action: "synchronize", number: 7, pull_request: { head: { ref: "x", repo: null } }, repository: { full_name: "acme/app" } };
        const missing = { action: "synchronize", number: 7, pull_request: { head: { ref: "x" } }, repository: { full_name: "acme/app" } };

        expect(parsePullRequestEvent(deleted)).toMatchObject({ fromFork: true });
        expect(parsePullRequestEvent(missing)).toMatchObject({ fromFork: true });
    });

    it("treats a head repository differing only in case as the same repository", () => {
        const same = {
            action: "opened",
            number: 7,
            pull_request: { head: { ref: "x", repo: { full_name: "Acme/App" } } },
            repository: { full_name: "acme/app" },
        };

        expect(parsePullRequestEvent(same)).toMatchObject({ fromFork: false });
    });

    it("maps closed to remove", () => {
        expect(parsePullRequestEvent(payload("closed"))).toStrictEqual({ action: "remove", branch: "feat/x", number: 7, repository: "acme/app" });
    });

    it("returns null for irrelevant actions and malformed payloads", () => {
        expect(parsePullRequestEvent(payload("labeled"))).toBeNull();
        expect(parsePullRequestEvent({ action: "opened" })).toBeNull();
        expect(parsePullRequestEvent(null)).toBeNull();
    });
});

describe(handleGitHubWebhook, () => {
    const secret = "whsec";
    const prBody = JSON.stringify({
        action: "opened",
        number: 7,
        pull_request: { head: { ref: "feat/x", repo: { full_name: "acme/app" } } },
        repository: { full_name: "acme/app" },
    });
    const resolveProject = (found: boolean) => () => Promise.resolve(found ? { organizationId: "org_1", projectId: "proj_1", slug: "app" } : null);

    const signedRequest = async (body: string): Promise<Request> =>
        new Request("https://cloud/v1/github/webhook", { body, headers: { "x-hub-signature-256": await sign(secret, body) }, method: "POST" });

    it("401s on a bad signature", async () => {
        const request = new Request("https://cloud/v1/github/webhook", { body: prBody, headers: { "x-hub-signature-256": "sha256=bad" }, method: "POST" });
        const response = await handleGitHubWebhook(request, { resolveProject: resolveProject(true), secret });

        expect(response.status).toBe(401);
    });

    it("resolves the project and returns the preview script name", async () => {
        const response = await handleGitHubWebhook(await signedRequest(prBody), { resolveProject: resolveProject(true), secret });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
            accepted: true,
            intent: { action: "upsert", branch: "feat/x", fromFork: false, number: 7, repository: "acme/app" },
            previewScriptName: "app-pr-feat-x",
            projectId: "proj_1",
        });
    });

    it("records a fork's pull request as a fork build, named by its number rather than its branch", async () => {
        const recorded: unknown[] = [];
        const body = JSON.stringify({
            action: "opened",
            installation: { id: 42 },
            number: 9,
            // A fork branch named like the team's own preview branch.
            pull_request: { base: { sha: "base1" }, head: { ref: "feat/x", repo: { full_name: "mallory/app" }, sha: "evil1" } },
            repository: { full_name: "acme/app" },
        });

        const response = await handleGitHubWebhook(await signedRequest(body), {
            onPreviewBuild: (intent) => {
                recorded.push(intent);

                return Promise.resolve({ buildId: "b1", reused: false });
            },
            resolveProject: resolveProject(true),
            secret,
        });

        expect(recorded).toStrictEqual([expect.objectContaining({ branch: "feat/x", commitSha: "evil1", fromFork: true, pullRequest: 9 })]);
        await expect(response.json()).resolves.toMatchObject({ previewScriptName: "app-fork-9" });
    });

    it("records a same-repository pull request as an ordinary preview build", async () => {
        const recorded: unknown[] = [];
        const body = JSON.stringify({
            action: "opened",
            installation: { id: 42 },
            number: 9,
            pull_request: { base: { sha: "base1" }, head: { ref: "feat/x", repo: { full_name: "acme/app" }, sha: "head1" } },
            repository: { full_name: "acme/app" },
        });

        await handleGitHubWebhook(await signedRequest(body), {
            onPreviewBuild: (intent) => {
                recorded.push(intent);

                return Promise.resolve({ buildId: "b1", reused: false });
            },
            resolveProject: resolveProject(true),
            secret,
        });

        expect(recorded).toStrictEqual([expect.objectContaining({ fromFork: false, pullRequest: 9 })]);
    });

    it("hands a push its delivery id and the commit it moved from, and acknowledges a redelivery without a build", async () => {
        const recorded: unknown[] = [];
        const body = JSON.stringify({
            after: "def456",
            before: "abc123",
            commits: [{ added: [], modified: ["src/a.ts"], removed: [] }],
            installation: { id: 42 },
            ref: "refs/heads/main",
            repository: { default_branch: "main", full_name: "acme/app" },
        });
        const request = new Request("https://cloud/v1/github/webhook", {
            body,
            headers: { "x-github-delivery": "guid-1", "x-github-event": "push", "x-hub-signature-256": await sign(secret, body) },
            method: "POST",
        });

        const response = await handleGitHubWebhook(request, {
            onPush: (intent) => {
                recorded.push(intent);

                return Promise.resolve({ duplicate: true });
            },
            resolveProject: resolveProject(true),
            secret,
        });

        expect(recorded).toStrictEqual([expect.objectContaining({ before: "abc123", commitSha: "def456", deliveryId: "guid-1" })]);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ duplicate: true, ignored: true });
    });

    it("202s when the repository is not connected to a project", async () => {
        const response = await handleGitHubWebhook(await signedRequest(prBody), { resolveProject: resolveProject(false), secret });

        expect(response.status).toBe(202);
    });
});

describe(pushChanges, () => {
    const commit = (...files: string[]) => {
        return { added: files, modified: [], removed: [] };
    };

    it("unions added, modified and removed across every commit", () => {
        expect(
            pushChanges({
                before: "aaa",
                commits: [
                    { added: ["apps/web/a.ts"], modified: ["README.md"], removed: [] },
                    { added: [], modified: ["README.md"], removed: ["apps/docs/b.md"] },
                ],
            }),
        ).toStrictEqual({ files: ["apps/web/a.ts", "README.md", "apps/docs/b.md"] });
    });

    it.each([
        ["a forced push", { before: "aaa", commits: [commit("x")], forced: true }, "forced push"],
        ["a created branch", { before: "aaa", commits: [commit("x")], created: true }, "new branch"],
        ["a zero `before`", { before: "0000000", commits: [commit("x")] }, "new branch"],
        ["no commits", { before: "aaa", commits: [] }, "the push lists no commits"],
        ["a missing commits list", { before: "aaa" }, "the push lists no commits"],
        [
            "a possibly truncated list",
            { before: "aaa", commits: Array.from({ length: 20 }, () => commit("x")) },
            "the push lists 20 commits and may be truncated",
        ],
        ["a commit without file lists", { before: "aaa", commits: [{ added: ["x"] }] }, "a commit is missing its file lists"],
        ["a non-string file", { before: "aaa", commits: [{ added: [42], modified: [], removed: [] }] }, "a commit is missing its file lists"],
    ])("cannot prove the changes of %s, so the push builds", (_label, payload, reason) => {
        expect(pushChanges(payload as Parameters<typeof pushChanges>[0])).toStrictEqual({ unknown: reason });
    });
});

describe("preview path filter", () => {
    const secret = "whsec";
    const body = JSON.stringify({
        action: "synchronize",
        installation: { id: 42 },
        number: 7,
        pull_request: { base: { sha: "base1" }, head: { ref: "feat/x", repo: { full_name: "acme/app" }, sha: "head1" } },
        repository: { full_name: "acme/app" },
    });
    const resolveProject = () => Promise.resolve({ organizationId: "org_1", projectId: "proj_1", slug: "app" });

    const deliver = async (listChangedFiles?: () => Promise<PushChanges>): Promise<PushChanges | undefined> => {
        let seen: PushChanges | undefined;
        const request = new Request("https://cloud/v1/github/webhook", { body, headers: { "x-hub-signature-256": await sign(secret, body) }, method: "POST" });

        await handleGitHubWebhook(request, {
            ...(listChangedFiles === undefined ? {} : { listChangedFiles }),
            onPreviewBuild: (intent) => {
                seen = intent.changes;

                return Promise.resolve({ buildId: "b1", reused: false, skipped: "no changes under apps/web/" });
            },
            resolveProject,
            secret,
        });

        return seen;
    };

    it("hands the PR's changed files (base...head) to the build recorder", async () => {
        const calls: unknown[] = [];
        const changes = await deliver((range?: unknown) => {
            calls.push(range);

            return Promise.resolve({ files: ["apps/docs/x.md"] });
        });

        expect(changes).toStrictEqual({ files: ["apps/docs/x.md"] });
        expect(calls).toStrictEqual([{ base: "base1", head: "head1", installationId: 42, repository: "acme/app" }]);
    });

    it("builds unfiltered when the compare call fails", async () => {
        await expect(deliver(() => Promise.reject(new Error("github compare failed: 502")))).resolves.toStrictEqual({
            unknown: "listing the pull request's files failed: github compare failed: 502",
        });
    });

    it("builds unfiltered without App credentials", async () => {
        await expect(deliver()).resolves.toStrictEqual({ unknown: "the control plane cannot list pull request files (no GitHub App credentials)" });
    });
});
