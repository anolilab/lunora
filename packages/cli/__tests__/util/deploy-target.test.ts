import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDeployTargetOrError, resolveDevTargetOrError, resolveRunnableTargetOrError, resolveTargetOrError } from "../../src/util/deploy-target-resolve";

/**
 * `target: "node"` is a registered deploy target with NO `DriverToolchain`:
 * there is no control plane to deploy to. It was still selectable end to end —
 * `deploy` threw only at the wrangler step, after codegen had rewritten
 * `_generated/*` for `NODE_CAPABILITIES`. `lunora dev` serves it on the CLI's
 * own Node host, so only the deploy path refuses it.
 */
describe("resolveRunnableTargetOrError", () => {
    let workdir: string;

    const writeTarget = (target: string): void => {
        writeFileSync(join(workdir, "lunora.config.ts"), `export default ${JSON.stringify({ target })};\n`, "utf8");
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
        // The message has to be actionable, not just a refusal: dev and codegen for
        // this target still work, and the deployable ids are what the caller needs.
        expect(resolved.error).toMatch(/lunora dev --target node.*cloudflare/);
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

    it("honours an explicit --target over lunora.config.ts", () => {
        expect.assertions(1);

        writeTarget("cloudflare");

        expect(resolveRunnableTargetOrError(workdir, "node").error).toMatch(/no command-line toolchain/);
    });
});

describe("resolveDeployTargetOrError", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-deploy-container-target-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("accepts node, which deploys as a container, from the config and from --target", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default ${JSON.stringify({ target: "node" })};\n`, "utf8");

        expect(resolveDeployTargetOrError(workdir)).toStrictEqual({ target: "node" });
        expect(resolveDeployTargetOrError(workdir, "node")).toStrictEqual({ target: "node" });
    });

    it("keeps the toolchain refusal for every other command, naming the dev server and the container deploy", () => {
        expect.assertions(2);

        // `lunora build` and `lunora prepare` resolve through the toolchain form, which must not start accepting node.
        expect(resolveRunnableTargetOrError(workdir, "node").error).toMatch(/lunora deploy --target node.*container/u);
        expect(resolveRunnableTargetOrError(workdir, "node").error).toMatch(/lunora dev --target node` serves it locally/u);
    });

    it("still resolves a toolchain target and passes an unknown target's error through", () => {
        expect.assertions(2);

        expect(resolveDeployTargetOrError(workdir, "cloudflare")).toStrictEqual({ target: "cloudflare" });
        expect(resolveDeployTargetOrError(workdir, "aws").error).toMatch(/unknown deploy target "aws"/u);
    });
});

describe("resolveDevTargetOrError", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-dev-target-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("accepts node for lunora dev, which the toolchain resolver still refuses", () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default ${JSON.stringify({ target: "node" })};\n`, "utf8");

        expect(resolveDevTargetOrError(workdir)).toStrictEqual({ target: "node" });
        expect(resolveDevTargetOrError(workdir, "node")).toStrictEqual({ target: "node" });
        expect(resolveRunnableTargetOrError(workdir).error).toMatch(/cannot run it/u);
    });

    it("still resolves a toolchain target and passes an unknown target's error through", () => {
        expect.assertions(2);

        expect(resolveDevTargetOrError(workdir, "cloudflare")).toStrictEqual({ target: "cloudflare" });
        expect(resolveDevTargetOrError(workdir, "aws").error).toMatch(/unknown deploy target "aws"/u);
    });
});
