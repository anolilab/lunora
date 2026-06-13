import { describe, expect, it } from "vitest";

import { parsePullRequestEvent, verifyGitHubSignature } from "../src/github/webhook";

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
            expect(parsePullRequestEvent(payload(action))).toStrictEqual({ action: "upsert", branch: "feat/x", number: 7, repository: "acme/app" });
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
