import { describe, expect, it } from "vitest";

import { evaluateAdvisoryGate } from "../src/util/advisory-gate";

interface GateAdvisory {
    level: "ERROR" | "INFO" | "WARN";
    name: string;
    suppressed?: { file: string; line: number; reason: string };
}

const accepted: GateAdvisory = {
    level: "ERROR",
    name: "allow_unauthenticated_shard_access_enabled",
    suppressed: { file: "lunora/server.ts", line: 2, reason: "single-tenant demo" },
};

const open: GateAdvisory = { level: "ERROR", name: "unindexed_foreign_key" };

describe("evaluateAdvisoryGate", () => {
    it("blocks on an unsuppressed ERROR and names only that one", () => {
        expect.assertions(3);

        const result = evaluateAdvisoryGate([accepted, open], true);

        expect(result.shouldBlock).toBe(true);
        expect(result.names).toStrictEqual(["unindexed_foreign_key"]);
        expect(result.errorAdvisories).toStrictEqual([open]);
    });

    it("does not block when the only ERROR is suppressed, and the caller keeps it in the list", () => {
        expect.assertions(4);

        const advisories: GateAdvisory[] = [accepted];
        const result = evaluateAdvisoryGate(advisories, true);

        expect(result.shouldBlock).toBe(false);
        expect(result.names).toStrictEqual([]);
        expect(result.errorAdvisories).toStrictEqual([]);
        // Suppression is visibility, not removal: the list the caller passed still holds the finding.
        expect(advisories).toContain(accepted);
    });
});
