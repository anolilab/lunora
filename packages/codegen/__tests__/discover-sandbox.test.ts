import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSandboxUsage } from "../src/discover-sandbox";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeAgents = (source: string): void => {
    writeFileSync(join(workdir, "agents.ts"), source);
};

describe("discover-sandbox", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-sandbox-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports no usage when lunora/ imports nothing from the sandbox subpath", () => {
        expect.assertions(1);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: false, usesSandboxContainer: false });
    });

    it("detects a named browserTool import from the sandbox subpath", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            import { browserTool as bt } from "@lunora/agent/sandbox";
            export const support = defineAgent({ model: "m", tools: { browser: bt() } });
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: true, usesSandboxContainer: false });
    });

    it("detects sandbox tools re-exported from the @lunora/agent main entry (the documented import)", () => {
        expect.assertions(1);

        // index.ts re-exports browserTool/containerTool, so the documented
        // `import { browserTool, containerTool } from "@lunora/agent"` must be
        // detected too — otherwise codegen silently skips the dispatcher.
        writeAgents(`
            import { browserTool, containerTool, defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", tools: { browser: browserTool(), box: containerTool("worker") } });
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: true, usesSandboxContainer: true });
    });

    it("detects both browserTool and containerTool from the sandbox subpath", () => {
        expect.assertions(1);

        writeAgents(`
            import { browserTool, containerTool } from "@lunora/agent/sandbox";
            import { defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", tools: { browser: browserTool(), box: containerTool("sandbox") } });
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: true, usesSandboxContainer: true });
    });

    it("does not false-positive on a browserTool imported from another module", () => {
        expect.assertions(1);

        writeAgents(`
            import { browserTool } from "./local-browser-tool";
            export const x = browserTool();
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: false, usesSandboxContainer: false });
    });

    it("ignores a type-only import of the sandbox subpath", () => {
        expect.assertions(1);

        writeAgents(`
            import type { BrowserToolInput } from "@lunora/agent/sandbox";
            export const shape = (input: BrowserToolInput): BrowserToolInput => input;
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: false, usesSandboxContainer: false });
    });

    it("ignores an inline type-only named specifier", () => {
        expect.assertions(1);

        writeAgents(`
            import { containerTool, type ContainerToolInput } from "@lunora/agent/sandbox";
            export const box = containerTool("sandbox");
            export const shape = (input: ContainerToolInput): ContainerToolInput => input;
        `);

        expect(discoverSandboxUsage(newProject(), workdir)).toStrictEqual({ usesSandboxBrowser: false, usesSandboxContainer: true });
    });
});
