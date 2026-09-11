import { describe, expect, it } from "vitest";

import { isDeployCapable } from "../src/deploy/capability";

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
