import { describe, expect, it } from "vitest";

import { resolveDeployDriver } from "../src/driver-registry";

/**
 * The Node driver exists so `"target": "node"` resolves and codegen can gate the
 * emitted `ctx.*` surface against `NODE_CAPABILITIES`. What this target cannot
 * serve — containers, declared crons — is reported by that matrix through
 * codegen's `platform_unsupported_feature` diagnostics, which is a path an
 * operator actually reads; the driver's own `infer`/`provision` report was never
 * called by anything and is gone.
 */
describe("node deploy driver", () => {
    const driver = resolveDeployDriver("node");

    it("is selectable and identifies itself", () => {
        expect.assertions(2);

        expect(driver.id).toBe("node");
        expect(driver.name).toBe("Node");
    });

    it("declares no toolchain, because Node has no vendor CLI to shell out to", () => {
        expect.assertions(1);

        // `DriverToolchain` describes commands like `wrangler deploy` / `tail` /
        // `secret put`. There is no hosted control plane, log stream or remote
        // secret store here, so claiming a toolchain would mean inventing
        // commands that cannot run — and `isRunnableTarget` refuses the target
        // for the commands that would need one.
        expect(driver.toolchain).toBeUndefined();
    });
});
