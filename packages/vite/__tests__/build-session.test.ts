import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markBuildStarted, oncePerBuild } from "../src/build-session";

let workdir: string;

const project = (overrides: { target?: string } = {}) => {
    return { apiSpec: "openapi" as const, lazyFunctions: false, projectRoot: workdir, schemaDir: "lunora", target: overrides.target ?? "cloudflare" };
};

describe(oncePerBuild, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-build-session-"));
        mkdirSync(join(workdir, "lunora"));
        writeFileSync(join(workdir, "lunora", "schema.ts"), "export const schema = {};\n");
        writeFileSync(join(workdir, "wrangler.jsonc"), '{ "name": "app" }\n');
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("runs a step once across one build's config passes, and afresh for the next build", async () => {
        expect.assertions(3);

        let runs = 0;
        const step = async (): Promise<number> =>
            oncePerBuild(project(), "step", () => {
                runs += 1;

                return runs;
            });

        // The app pass, then one pass per environment.
        await step();
        await step();

        await expect(step()).resolves.toBe(1);

        markBuildStarted(project());

        await expect(step()).resolves.toBe(2);
        expect(runs).toBe(2);
    });

    it("runs again when a source, the wrangler config, or a codegen option changed", async () => {
        expect.assertions(1);

        let runs = 0;
        const run = (): void => {
            runs += 1;
        };

        await oncePerBuild(project(), "step", run);
        appendFileSync(join(workdir, "lunora", "schema.ts"), "// edit\n");
        await oncePerBuild(project(), "step", run);
        writeFileSync(join(workdir, "wrangler.jsonc"), '{ "name": "renamed" }\n');
        await oncePerBuild(project(), "step", run);
        await oncePerBuild(project({ target: "node" }), "step", run);

        expect(runs).toBe(4);
    });

    it("keeps the session across the step's own writes", async () => {
        expect.assertions(1);

        let runs = 0;
        // Like binding provisioning: the step itself rewrites wrangler.jsonc.
        const run = (): void => {
            runs += 1;
            writeFileSync(join(workdir, "wrangler.jsonc"), '{ "name": "app", "durable_objects": { "bindings": [] } }\n');
        };

        await oncePerBuild(project(), "step", run);
        await oncePerBuild(project(), "step", run);

        expect(runs).toBe(1);
    });

    it("does not record a step that threw", async () => {
        expect.assertions(2);

        await expect(
            oncePerBuild(project(), "step", () => {
                throw new Error("invalid wrangler.jsonc");
            }),
        ).rejects.toThrow("invalid wrangler.jsonc");

        await expect(oncePerBuild(project(), "step", () => "ran")).resolves.toBe("ran");
    });
});
