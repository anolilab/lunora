import { describe, expect, it } from "vitest";

import { handleGitHubWebhook, parsePullRequestEvent, verifyGitHubSignature } from "../src/github/webhook";

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
        return { action, number: 7, pull_request: { head: { ref: "feat/x" } }, repository: { full_name: "acme/app" } };
    };

    it("maps opened/synchronize/reopened to upsert", () => {
        for (const action of ["opened", "synchronize", "reopened"]) {
            expect(parsePullRequestEvent(payload(action))).toMatchObject({ action: "upsert", branch: "feat/x", number: 7, repository: "acme/app" });
        }
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
    const prBody = JSON.stringify({ action: "opened", number: 7, pull_request: { head: { ref: "feat/x" } }, repository: { full_name: "acme/app" } });
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
            intent: { action: "upsert", branch: "feat/x", number: 7, repository: "acme/app" },
            previewScriptName: "app-pr-feat-x",
            projectId: "proj_1",
        });
    });

    it("202s when the repository is not connected to a project", async () => {
        const response = await handleGitHubWebhook(await signedRequest(prBody), { resolveProject: resolveProject(false), secret });

        expect(response.status).toBe(202);
    });
});
