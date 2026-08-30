import { describe, expect, it } from "vitest";

import { rollRefusalReason } from "../lunora/deploy-keys";
import { formatDeployKey, hashDeployKey, parseDeployKey, randomSecret } from "../src/deploy/keys";

describe("deploy key helpers", () => {
    it("round-trips an org-scoped key through format → parse", () => {
        const key = formatDeployKey({ organizationId: "org_1", secret: "s3cret", type: "production" });

        expect(key).toBe("production:org_1|s3cret");
        expect(parseDeployKey(key)).toStrictEqual({ organizationId: "org_1", secret: "s3cret", type: "production" });
    });

    it("round-trips a project-scoped preview key", () => {
        const key = formatDeployKey({ organizationId: "org_1", projectId: "proj_2", secret: "abc", type: "preview" });

        expect(key).toBe("preview:org_1:proj_2|abc");
        expect(parseDeployKey(key)).toStrictEqual({ organizationId: "org_1", projectId: "proj_2", secret: "abc", type: "preview" });
    });

    it("returns null for a malformed key", () => {
        expect(parseDeployKey("not-a-key")).toBeNull();
        expect(parseDeployKey("bogus:org_1|secret")).toBeNull();
        expect(parseDeployKey("production:|secret")).toBeNull();
    });

    it("hashes deterministically and distinctly", async () => {
        const a = await hashDeployKey("production:org_1|secret");
        const b = await hashDeployKey("production:org_1|secret");
        const c = await hashDeployKey("production:org_1|different");

        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("mints 256-bit hex secrets", () => {
        const secret = randomSecret();

        expect(secret).toMatch(/^[0-9a-f]{64}$/u);
        expect(randomSecret()).not.toBe(secret);
    });
});

describe(rollRefusalReason, () => {
    it("allows rolling a live deploy key", () => {
        expect(rollRefusalReason({})).toBeUndefined();
        expect(rollRefusalReason({ capability: "deploy" })).toBeUndefined();
    });

    it("refuses a key that is already revoked", () => {
        expect(rollRefusalReason({ revokedAt: 1 })).toMatch(/already revoked/);
    });

    /**
     * The trap this guards. A platform-managed ingest key stores an
     * envelope-encrypted copy of its plaintext, which the deploy path re-injects
     * into the tenant's `otlpSink`. Rolling one would mint a new secret and leave
     * that cipher pointing at the revoked one, so every later deploy would inject
     * a dead token — and nothing reads telemetry back to notice, so the org's
     * traces would simply stop with no error raised anywhere.
     */
    it("refuses a platform-managed ingest key", () => {
        expect(rollRefusalReason({ capability: "ingest" })).toMatch(/platform-managed/);
    });
});
