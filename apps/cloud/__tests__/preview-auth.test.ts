import { describe, expect, it } from "vitest";

import { PREVIEW_SESSION_MS, previewCookieHeader, readCookie, signPreviewToken, verifyPreviewToken } from "../src/dispatcher/preview-auth";

const TOKEN = "cp_secret_token"; // gitleaks:allow -- fabricated fixture, not a credential
const NOW = 1_700_000_000_000;

describe(signPreviewToken, () => {
    it("round-trips a token for the script it was minted for", async () => {
        const token = await signPreviewToken("acme-pr-42", TOKEN, NOW);

        await expect(verifyPreviewToken(token, "acme-pr-42", TOKEN, NOW + 1000)).resolves.toBe(true);
    });

    /**
     * The property that makes a shared parent domain safe. Preview hostnames sit
     * under one apex, so the browser offers a host-scoped cookie to every other
     * preview in the account — signing the script into the payload is what stops
     * one preview's cookie opening the next.
     */
    it("does not authorise a different script", async () => {
        const token = await signPreviewToken("acme-pr-42", TOKEN, NOW);

        await expect(verifyPreviewToken(token, "acme-pr-43", TOKEN, NOW + 1000)).resolves.toBe(false);
    });

    it("expires", async () => {
        const token = await signPreviewToken("acme-pr-42", TOKEN, NOW);

        await expect(verifyPreviewToken(token, "acme-pr-42", TOKEN, NOW + PREVIEW_SESSION_MS + 1)).resolves.toBe(false);
    });

    /** Rotating the control-plane token invalidates outstanding cookies — the intended blast radius. */
    it("does not verify under a different control-plane token", async () => {
        const token = await signPreviewToken("acme-pr-42", TOKEN, NOW);

        await expect(verifyPreviewToken(token, "acme-pr-42", "cp_rotated", NOW + 1000)).resolves.toBe(false); // gitleaks:allow -- fabricated fixture
    });

    /**
     * The forgery attempt this defends against: rewrite the claims, keep the
     * signature. Verification recomputes the MAC over the payload, so a tampered
     * payload fails before anything inside it is read.
     */
    it("rejects a tampered payload that keeps a valid-looking signature", async () => {
        const token = await signPreviewToken("acme-pr-42", TOKEN, NOW);
        const [, signature] = token.split(".");
        const forgedPayload = btoa(JSON.stringify({ exp: NOW + PREVIEW_SESSION_MS, script: "acme-pr-43" }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");

        await expect(verifyPreviewToken(`${forgedPayload}.${signature ?? ""}`, "acme-pr-43", TOKEN, NOW + 1000)).resolves.toBe(false);
    });

    it("rejects structurally broken tokens rather than throwing", async () => {
        await expect(verifyPreviewToken("", "acme-pr-42", TOKEN, NOW)).resolves.toBe(false);
        await expect(verifyPreviewToken("nodot", "acme-pr-42", TOKEN, NOW)).resolves.toBe(false);
        await expect(verifyPreviewToken(".onlysig", "acme-pr-42", TOKEN, NOW)).resolves.toBe(false);
        await expect(verifyPreviewToken("onlypayload.", "acme-pr-42", TOKEN, NOW)).resolves.toBe(false);
        await expect(verifyPreviewToken("not-base64!.also-not", "acme-pr-42", TOKEN, NOW)).resolves.toBe(false);
    });
});

describe(readCookie, () => {
    it("reads the preview cookie out of a multi-cookie header", () => {
        expect(readCookie("a=1; __lunora_preview=abc.def; b=2")).toBe("abc.def");
    });

    /** A base64url token can contain no `=`, but the joined value does — a naive split would truncate it. */
    it("keeps a value containing an equals sign intact", () => {
        expect(readCookie("__lunora_preview=abc=def")).toBe("abc=def");
    });

    it("does not match a cookie whose name merely ends with the target", () => {
        expect(readCookie("not__lunora_preview=abc")).toBeUndefined();
    });

    it("answers undefined for an absent header or cookie", () => {
        expect(readCookie(null)).toBeUndefined();
        expect(readCookie("other=1")).toBeUndefined();
    });
});

describe(previewCookieHeader, () => {
    /**
     * A preview is exactly where half-finished code runs, so the cookie is
     * HttpOnly; previews are HTTPS-only, so Secure; and no `Domain` attribute, so
     * the browser does not offer it to sibling previews under the same apex.
     */
    it("sets the flags that keep the cookie scoped and unreadable to script", () => {
        const header = previewCookieHeader("abc.def");

        expect(header).toContain("HttpOnly");
        expect(header).toContain("Secure");
        expect(header).toContain("SameSite=Lax");
        expect(header).toContain("Path=/");
        expect(header).not.toContain("Domain=");
    });
});
