import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlatformCodeSignals } from "../../src/discover/platform-signals";
import { discoverPlatformSignals } from "../../src/discover/platform-signals";

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const signals = (): PlatformCodeSignals => discoverPlatformSignals(project, join(workdir, "lunora"));

// eslint-disable-next-line no-secrets/no-secrets -- false positive: a function name in a describe label, not a credential
describe("discoverPlatformSignals", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-platform-signals-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports nothing for an app that declares neither", () => {
        expect.assertions(1);

        write(
            "plain.ts",
            `import { query } from "@lunora/server";\n\nexport const list = query({ args: {}, handler: async (ctx) => ctx.db.query("users").collect() });\n`,
        );

        expect(signals()).toStrictEqual({ containerEgressPolicy: false, durableStreams: false, secrets: false, workflowRollback: false });
    });

    // A host without step rollback fails the step rather than run it without
    // the compensation, so a declared rollback must reach the platform gate.
    it("detects a workflow step that declares a rollback, inline or hoisted", () => {
        expect.assertions(2);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nexport const charge = defineStep("charge", { args: {}, handler: async () => 1, rollback: async () => {} });\n`,
        );

        expect(signals().workflowRollback).toBe(true);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nconst config = { args: {}, handler: async () => 1, rollback: async () => {} };\n\nexport const charge = defineStep("charge", config);\n`,
        );
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().workflowRollback).toBe(true);
    });

    it("does not treat a step without a rollback, or `rollback: undefined`, as a declaration", () => {
        expect.assertions(1);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nexport const a = defineStep("a", { args: {}, handler: async () => 1 });\nexport const b = defineStep("b", { args: {}, handler: async () => 1, rollback: undefined });\n`,
        );

        expect(signals().workflowRollback).toBe(false);
    });

    it("detects a container egress policy by any of its keys, and not an explicit opt-out", () => {
        expect.assertions(2);

        write(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\n\nexport const box = defineContainer({ image: "./Dockerfile", interceptHttps: false });\n`,
        );

        expect(signals().containerEgressPolicy).toBe(false);

        write(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\n\nexport const box = defineContainer({ allowedHosts: ["example.com"], image: "./Dockerfile" });\n`,
        );
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().containerEgressPolicy).toBe(true);
    });

    it("detects a durable stream declared on the builder terminal", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: true });\n`);

        expect(signals().durableStreams).toBe(true);
    });

    it("does not treat an ephemeral stream as durable", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {});\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("does not treat an explicit `durable: false` as a declaration", () => {
        expect.assertions(1);

        // Presence of the key used to be the whole test, so an app that
        // explicitly opted OUT of durability hard-failed the build on a host
        // that rates durableStreams unsupported.
        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: false });\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("does not treat a parenthesized `durable: (false)` as a declaration", () => {
        expect.assertions(1);

        // The opt-out is read off the initializer's TEXT, so any wrapping the
        // user's formatter leaves behind — `(false)`, `((false))` — used to read
        // as a declaration and hard-fail the build on a host that rates
        // durableStreams unsupported.
        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: (false) });\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("detects a destructured ctx.secrets read", () => {
        expect.assertions(1);

        // The gate exists so codegen refuses an app reading ctx.secrets on a
        // host without a secrets binding, instead of emitting a surface that
        // throws on first use. Matching only `ctx.secrets` handed that app
        // exactly the surface it was supposed to refuse.
        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => {\n    const { secrets } = ctx;\n\n    return secrets.get("STRIPE_KEY");\n} });\n`,
        );

        expect(signals().secrets).toBe(true);
    });

    it("detects a ctx.secrets read", () => {
        expect.assertions(1);

        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => ctx.secrets.get("STRIPE_KEY") });\n`,
        );

        expect(signals().secrets).toBe(true);
    });
});
