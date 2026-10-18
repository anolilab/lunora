import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSecretValueToolUsage from "../../src/discover/secret-value-tool";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeAgents = (source: string): void => {
    writeFileSync(join(workdir, "agents.ts"), source);
};

describe("discover/secret-value-tool", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-secret-value-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports no usage when lunora/ never imports the secret tool", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", tools: {} });
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("detects a value import of requestSecretTool from the agent package, under an alias", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent, requestSecretTool as ask } from "@lunora/agent";
            export const support = defineAgent({ model: "m", tools: { ask: ask() } });
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("ignores a type-only import of the name", () => {
        expect.assertions(1);

        writeAgents(`
            import type { requestSecretTool } from "@lunora/agent";
            export type Tool = typeof requestSecretTool;
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("ignores the same name imported from another package", () => {
        expect.assertions(1);

        writeAgents(`
            import { requestSecretTool } from "some-other-package";
            export const tool = requestSecretTool;
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });
});
