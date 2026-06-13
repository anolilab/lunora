import { describe, expect, it } from "vitest";

import { createAlchemyProvisioner } from "../src/provision";

describe("provision adapter (Alchemy v2 seam)", () => {
    const provisioner = createAlchemyProvisioner({ cell: "cell-1", cloudflareApiToken: "test-token" });

    it("exposes the deploy/destroy contract", () => {
        expect(typeof provisioner.deploy).toBe("function");
        expect(typeof provisioner.destroy).toBe("function");
    });

    // The adapter is a Phase 1 spike deliverable (CLOUD-PLAN.md §2.2 / risk #7);
    // until it's wired over alchemy@next, both operations reject loudly rather
    // than silently no-op.
    it("rejects until wired over alchemy@next", async () => {
        await expect(
            provisioner.deploy({
                bindings: {},
                bundle: new ArrayBuffer(0),
                cell: "cell-1",
                dispatchNamespace: "cirrus-production",
                scriptName: "org__project",
                secrets: {},
                tags: [],
            }),
        ).rejects.toThrow(/not wired yet/u);

        await expect(provisioner.destroy({ cell: "cell-1", scriptName: "org__project" })).rejects.toThrow(/not wired yet/u);
    });
});
