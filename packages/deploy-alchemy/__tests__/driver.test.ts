import { deployTargetIds, isWorkerdSafeDriver, resolveDeployDriver } from "@lunora/config";
import { describe, expect, it } from "vitest";

import { ALCHEMY_DRIVER, ALCHEMY_TARGET, useAlchemyDeployDriver } from "../src";

describe("alchemy deploy driver", () => {
    it("is not registered until the project opts in", () => {
        expect.assertions(1);

        // The whole reason this package is separate: `@lunora/config` is
        // imported by `@lunora/vite`, and Alchemy drags in thirty dependencies
        // — `wrangler`, `miniflare`, `esbuild`, `execa` among them. A project
        // that never asked for it must not pay for it.
        expect(deployTargetIds()).not.toContain(ALCHEMY_TARGET);
    });

    it("resolves once registered, and registering twice is a no-op", () => {
        expect.assertions(3);

        expect(useAlchemyDeployDriver()).toBe(ALCHEMY_DRIVER);
        expect(resolveDeployDriver(ALCHEMY_TARGET)).toBe(ALCHEMY_DRIVER);

        // Idempotent by id, so a module that registers on import is safe to
        // import twice.
        expect(useAlchemyDeployDriver()).toBe(ALCHEMY_DRIVER);
    });

    it("declares itself Node-only", () => {
        expect.assertions(2);

        // The blocker that is otherwise invisible until a bundle breaks: nine
        // of Alchemy's dependencies are Node-shaped and none survive workerd.
        // A control plane running in a Worker asks this before importing.
        expect(ALCHEMY_DRIVER.runtime).toBe("node");
        expect(isWorkerdSafeDriver(ALCHEMY_DRIVER)).toBe(false);
    });

    it("builds an alchemy deploy invocation rather than a wrangler one", () => {
        expect.assertions(3);

        const command = ALCHEMY_DRIVER.toolchain?.deploy({ environment: "production" });

        expect(command?.tool).toBe("alchemy");
        expect(command?.args).toContain("deploy");

        // `--stage` is Alchemy's deploy environment; the neutral `environment`
        // request maps onto it rather than onto a wrangler `--env`.
        expect(command?.args).toStrictEqual(["deploy", "alchemy.run.ts", "--stage", "production"]);
    });

    it("omits the stage when no environment was asked for", () => {
        expect.assertions(1);

        // Not `--stage ""`: an empty stage would override Alchemy's own default
        // with nothing, which is a different deployment from "unspecified".
        expect(ALCHEMY_DRIVER.toolchain?.deploy({})?.args).toStrictEqual(["deploy", "alchemy.run.ts"]);
    });

    it("reports no CLI step for secrets", () => {
        expect.assertions(2);

        // Alchemy declares secrets as resources inside the program, so there is
        // no command to run. Callers must surface that rather than skip it —
        // a silent no-op would read as "secrets pushed".
        expect(ALCHEMY_DRIVER.toolchain?.secretPut?.({ key: "STRIPE_KEY" })).toBeUndefined();
        expect(ALCHEMY_DRIVER.toolchain?.secretList?.({})).toBeUndefined();
    });

    it("shares inference with the Cloudflare driver instead of reimplementing it", () => {
        expect.assertions(1);

        // What an app needs falls out of its schema and imports; every target
        // reaches the same answer. Only the emission differs, which is the
        // split `ResourceGraph` exists to make possible.
        expect(ALCHEMY_DRIVER.infer).toBeDefined();
    });
});
