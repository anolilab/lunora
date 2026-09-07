import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRunnableTargetOrError, resolveTargetOrError } from "../../src/util/deploy-target";

/**
 * `target: "node"` is a registered deploy target with NO `DriverToolchain`:
 * there is no control plane to deploy to and no local runtime the CLI can spawn.
 * It was still selectable end to end — `deploy` threw only at the wrangler step,
 * after codegen had rewritten `_generated/*` for `NODE_CAPABILITIES`, and `dev`
 * did not check at all (`toolchain?.dev(...)` fell through to `wrangler dev`,
 * serving a Node-target app on Cloudflare's runtime).
 */
describe("resolveRunnableTargetOrError", () => {
    let workdir: string;

    const writeTarget = (target: string): void => {
        writeFileSync(join(workdir, "lunora.json"), JSON.stringify({ target }), "utf8");
    };

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-deploy-target-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("accepts a target whose driver ships a toolchain", () => {
        expect.assertions(2);

        writeTarget("cloudflare");

        expect(resolveRunnableTargetOrError(workdir).target).toBe("cloudflare");
        expect(resolveRunnableTargetOrError(workdir).error).toBeUndefined();
    });

    it("rejects a registered target that ships no toolchain, naming what it can still do", () => {
        expect.assertions(3);

        writeTarget("node");

        const resolved = resolveRunnableTargetOrError(workdir);

        expect(resolved.target).toBeUndefined();
        expect(resolved.error).toMatch(/no command-line toolchain/);
        // The message has to be actionable, not just a refusal: codegen for this
        // target still works, and the deployable ids are what the caller needs.
        expect(resolved.error).toMatch(/cloudflare/);
    });

    it("still resolves the same target for the codegen-only path", () => {
        expect.assertions(1);

        writeTarget("node");

        // `resolveTargetOrError` gates `lunora codegen` / `verify`, which DO
        // support this target — the toolchain requirement is deploy/dev's alone.
        expect(resolveTargetOrError(workdir).target).toBe("node");
    });

    it("passes an unknown target's own error through unchanged", () => {
        expect.assertions(1);

        writeTarget("aws");

        expect(resolveRunnableTargetOrError(workdir).error).toMatch(/unknown deploy target "aws"/);
    });

    it("honours an explicit --target over lunora.json", () => {
        expect.assertions(1);

        writeTarget("cloudflare");

        expect(resolveRunnableTargetOrError(workdir, "node").error).toMatch(/no command-line toolchain/);
    });
});
