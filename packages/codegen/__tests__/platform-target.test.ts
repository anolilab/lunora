import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlatformCapabilities } from "@lunora/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeatureUsage } from "../src/discover-feature-usage";
import { readProjectTarget, resolveCodegenTarget } from "../src/platform-target";
import { runCodegen } from "../src/run-codegen";

const ALL_OFF: FeatureUsage = {
    access: false,
    ai: false,
    analytics: false,
    browser: false,
    container: false,
    flags: false,
    hyperdrive: false,
    images: false,
    kv: false,
    mail: false,
    payments: false,
    pipelines: false,
    r2sql: false,
    scheduler: false,
    storage: false,
    vectors: false,
    workflows: false,
    x402: false,
};

describe("gatePlatformFeatures", () => {
    it("is the identity for the default Cloudflare target (nothing unsupported)", async () => {
        expect.assertions(2);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, browser: true, storage: true, workflows: true };

        const result = gatePlatformFeatures(usage, "cloudflare");

        expect(result.diagnostics).toStrictEqual([]);
        // A copy, byte-for-byte equal — the emitted surface (and goldens) is unchanged.
        expect(result.usage).toStrictEqual(usage);
    });

    it("omits an unsupported feature and reports it", async () => {
        expect.assertions(4);

        // A synthetic target that lacks browser + object storage. Cloudflare marks
        // nothing unsupported, so the omission path needs a matrix that does —
        // which is exactly what a real per-target platform package would provide.
        // `gateAgainstMatrix` takes the matrix directly, so no module mocking.
        const partialTarget: PlatformCapabilities = {
            id: "partial",
            name: "Partial Host",
            features: {
                ai: { level: "native" },
                browser: { level: "unsupported" },
                objectStorage: { level: "unsupported" },
                workflows: { level: "emulated" },
            },
        };

        const { gateAgainstMatrix } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, browser: true, storage: true, workflows: true };

        const result = gateAgainstMatrix(usage, partialTarget, "partial");

        // Unsupported features flipped off; supported (native/emulated) left on.
        expect(result.usage.browser).toBe(false);
        expect(result.usage.storage).toBe(false);
        expect({ ai: result.usage.ai, workflows: result.usage.workflows }).toStrictEqual({ ai: true, workflows: true });

        // One diagnostic per omitted feature, each naming the ctx surface.
        expect(result.diagnostics.map((diagnostic) => diagnostic.feature).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            "browser",
            "storage",
        ]);
    });

    it("reports an unknown target and leaves the surface un-gated", async () => {
        expect.assertions(3);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, browser: true };

        const result = gatePlatformFeatures(usage, "some-future-host");

        // Fail safe: no matrix to gate against → nothing omitted...
        expect(result.usage).toStrictEqual(usage);
        // ...but a single error diagnostic flags the unconfigured target.
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_unknown_target");
    });

    it("never gates app-level features that have no platform mapping", async () => {
        expect.assertions(1);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        // flags / access / images / payments / x402 / r2sql are app add-ons, not
        // platform primitives — they must survive any target unchanged.
        const usage: FeatureUsage = { ...ALL_OFF, access: true, flags: true, images: true, payments: true, r2sql: true, x402: true };

        const result = gatePlatformFeatures(usage, "cloudflare");

        expect(result.usage).toStrictEqual(usage);
    });
});

describe("project-declared target", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixtureRoot = join(here, "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-target-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeConfig = (text: string): void => {
        writeFileSync(join(workdir, "lunora.json"), text, "utf8");
    };

    const diagnosticNames = (target?: string): string[] =>
        runCodegen({ projectRoot: workdir, target }).platformDiagnostics.map((diagnostic) => diagnostic.name);

    it("gates against the project's declared target when the caller passes none", () => {
        expect.assertions(2);

        expect(diagnosticNames()).toStrictEqual([]);

        writeConfig(`{ "target": "aws" }`);

        // The point of resolving inside `runCodegen`: a call site that forgets
        // to thread a target would otherwise emit the DEFAULT surface with no
        // diagnostic at all, and the mismatch would only surface at runtime on
        // the deployed app.
        expect(diagnosticNames()).toStrictEqual(["platform_unknown_target"]);
    });

    it("reads the target as JSONC, matching how the rest of lunora.json is parsed", () => {
        expect.assertions(1);

        // `@lunora/config` parses this file with `jsonc-parser`. A second reader
        // using plain `JSON.parse` would reject a config the CLI accepts, which
        // is exactly the drift a shared parser exists to prevent.
        writeConfig(`{\n    // the target we ship to\n    "target": "aws",\n}`);

        expect(diagnosticNames()).toStrictEqual(["platform_unknown_target"]);
    });

    it("lets an explicit target override the project config", () => {
        expect.assertions(1);

        writeConfig(`{ "target": "aws" }`);

        expect(diagnosticNames("cloudflare")).toStrictEqual([]);
    });

    it("degrades to the default on an unusable config rather than throwing", () => {
        expect.assertions(3);

        writeConfig("{ not json");

        expect(readProjectTarget(workdir)).toBeUndefined();

        writeConfig(`{ "target": 42 }`);

        // A non-string is a shape error, not a name the user meant — unlike a
        // misspelled string, which must reach the registry and be rejected.
        expect(readProjectTarget(workdir)).toBeUndefined();
        expect(resolveCodegenTarget(workdir)).toBe("cloudflare");
    });
});
