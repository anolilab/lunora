import { describe, expect, it } from "vitest";

import { ConflictError, createDependencyTracker, depKey, SCAN_DEP, tableFromDepKey } from "../src";

describe("@lunora/shard-engine smoke tests", () => {
    it("exports ConflictError with occ kind", () => {
        expect.assertions(3);

        const error = new ConflictError("write conflict", "occ");

        expect(error).toBeInstanceOf(ConflictError);
        expect(error.kind).toBe("occ");
        expect(error.message).toBe("write conflict");
    });

    it("tracks table dependencies", () => {
        expect.assertions(2);

        const tracker = createDependencyTracker();

        tracker.recordRead("messages", SCAN_DEP);

        const deps = tracker.collect();

        expect(deps).toContain(depKey("messages", SCAN_DEP));
        expect([...deps].map((dep) => tableFromDepKey(dep))).toContain("messages");
    });
});
