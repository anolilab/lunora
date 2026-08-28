import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every path that moves a project's active pointer must also clear its rollout.
 *
 * This exists because it did not, and the failure was invisible. `activate` is
 * the mutation CI calls on every deploy: it superseded the rollout candidate and
 * left the rollout set, so the dispatcher kept routing a share of production
 * traffic to a script the same mutation had just retired — indefinitely, and then
 * to a 404 once the teardown sweep deleted it. `rollback` had the same hole, with
 * a worse consequence: it is the control an operator reaches for when a release
 * misbehaves, and it reported success while the bad canary kept serving.
 *
 * A behavioural test would need a live control plane, so this asserts the
 * property over the source instead: any mutation that writes `activeScriptName`
 * writes `rollout` in the same patch. Coarse, but it fails for exactly the reason
 * the bug happened — a new pointer-moving path that forgets — which no
 * type-checker or lint rule catches.
 */

const SOURCE = readFileSync(fileURLToPath(new URL("../lunora/deployments.ts", import.meta.url)), "utf8");

/** The `context.db.patch(...)` calls that set the project's active pointer. */
const pointerPatches = (): string[] => {
    const calls: string[] = [];
    const marker = "activeScriptName:";
    let index = SOURCE.indexOf(marker);

    while (index !== -1) {
        // Walk back to the opening `{` of the patch object and forward to its `}`.
        const start = SOURCE.lastIndexOf("{", index);
        const end = SOURCE.indexOf("}", index);

        calls.push(SOURCE.slice(start, end + 1));
        index = SOURCE.indexOf(marker, index + marker.length);
    }

    return calls;
};

describe("rollout clearing", () => {
    it("finds every pointer-moving patch", () => {
        // `activate` and `rollback`. A third would be caught by the next assertion.
        expect(pointerPatches().length).toBeGreaterThanOrEqual(2);
    });

    it("clears the rollout in every patch that moves the active pointer", () => {
        for (const patch of pointerPatches()) {
            expect(patch).toContain("rollout: undefined");
        }
    });

    /** Promote is the one path that moves the pointer AND owns the rollout's end. */
    it("clears the rollout when promoting a candidate", () => {
        expect(SOURCE).toContain('action: "deployment.rollout.promote"');
        expect(pointerPatches().some((patch) => patch.includes("activeDeploymentId: candidateId"))).toBe(true);
    });
});
