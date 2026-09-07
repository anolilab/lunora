/**
 * The Vite half of the runnable-target guard.
 *
 * `resolveTargetOrThrow` accepts a codegen-only target like `node` —
 * legitimately, since generating for it is meaningful — so without this check
 * the plugin goes on to run the **Cloudflare** dev/build pipeline against it and
 * emits the wrong surface without saying so. The CLI refuses the same set in
 * `deploy`/`dev`; both sides share `isRunnableTarget`, so they cannot drift.
 */
import { isRunnableTarget, runnableTargetIds } from "@lunora/config";
import { describe, expect, it } from "vitest";

import { lunora } from "../src/index";

describe("lunora() — runnable target guard", () => {
    it("refuses a target whose driver ships no toolchain", () => {
        expect.assertions(2);

        // `node` is a real, registered target: `lunora codegen --target node`
        // works. What it has no answer for is "build or serve this".
        expect(isRunnableTarget("node")).toBe(false);
        expect(() => lunora({ target: "node" })).toThrow(/no command-line toolchain/);
    });

    it("names the buildable targets so the message is actionable", () => {
        expect.assertions(2);

        const runnable = runnableTargetIds();

        expect(runnable).toContain("cloudflare");
        expect(() => lunora({ target: "node" })).toThrow(new RegExp(runnable.join(", ")));
    });

    it("accepts a target that can actually be built", () => {
        expect.assertions(1);

        expect(() => lunora({ target: "cloudflare" })).not.toThrow();
    });
});
