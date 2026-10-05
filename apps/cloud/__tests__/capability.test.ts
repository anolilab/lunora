import { describe, expect, it } from "vitest";

import { isDeployCapable, isKeyLive } from "../src/deploy/capability";

describe(isDeployCapable, () => {
    it("treats a key with no capability as deploy-capable (the historical default)", () => {
        expect(isDeployCapable({})).toBe(true);
    });

    it("allows an explicit deploy key", () => {
        expect(isDeployCapable({ capability: "deploy" })).toBe(true);
    });

    it("rejects an ingest key from deploy/admin — the injected telemetry token can't ship code", () => {
        expect(isDeployCapable({ capability: "ingest" })).toBe(false);
    });
});

describe(isKeyLive, () => {
    it("accepts a key with neither a revocation nor a deadline", () => {
        expect(isKeyLive({}, 1000)).toBe(true);
    });

    it("rejects a revoked key", () => {
        expect(isKeyLive({ revokedAt: 500 }, 1000)).toBe(false);
    });

    it("accepts a key before its deadline and rejects it at or after", () => {
        expect(isKeyLive({ expiresAt: 1001 }, 1000)).toBe(true);
        expect(isKeyLive({ expiresAt: 1000 }, 1000)).toBe(false);
        expect(isKeyLive({ expiresAt: 999 }, 1000)).toBe(false);
    });
});
