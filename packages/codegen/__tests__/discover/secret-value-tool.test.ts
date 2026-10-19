import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const writeFile = (name: string, source: string): void => {
    writeFileSync(join(workdir, name), source);
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

    it("detects the tool in a helper that codegen.exclude skips but an agent still imports", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { codegen: { exclude: ["seed/**"] } };\n`, "utf8");
        mkdirSync(join(workdir, "seed"));
        writeFileSync(join(workdir, "seed", "tools.ts"), `import { requestSecretTool } from "@lunora/agent";\nexport const ask = requestSecretTool;\n`, "utf8");
        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            import { ask } from "./seed/tools";
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

    it("detects a namespace import of the agent package that calls requestSecretTool", () => {
        expect.assertions(1);

        writeAgents(`
            import * as agent from "@lunora/agent";
            export const support = agent.defineAgent({ model: "m", tools: { ask: agent.requestSecretTool({ consumer: "charge", description: "d" }) } });
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("ignores a namespace import of the agent package that never reads requestSecretTool", () => {
        expect.assertions(1);

        writeAgents(`
            import * as agent from "@lunora/agent";
            export const support = agent.defineAgent({ model: "m", tools: {} });
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("detects a tool imported through a barrel that re-exports it from the agent package", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export { requestSecretTool } from "@lunora/agent";`);
        writeAgents(`
            import { requestSecretTool } from "./tools";
            export const support = { ask: requestSecretTool({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a tool re-exported under an alias, imported by its alias", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export { requestSecretTool as askForKey } from "@lunora/agent";`);
        writeAgents(`
            import { askForKey } from "./tools";
            export const support = { ask: askForKey({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a tool a barrel re-exports with export *", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export * from "@lunora/agent";`);
        writeAgents(`
            import { requestSecretTool } from "./tools";
            export const support = { ask: requestSecretTool({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a tool defined in another module and imported as a value", () => {
        expect.assertions(1);

        writeFile(
            "tools.ts",
            `import { requestSecretTool } from "@lunora/agent";\nexport const requestKey = requestSecretTool({ consumer: "charge", description: "d" });`,
        );
        writeAgents(`
            import { requestKey } from "./tools";
            export const support = { ask: requestKey };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a second alias re-exported from the same module as the first", () => {
        expect.assertions(1);

        writeFile("source.ts", `export { requestSecretTool } from "@lunora/agent";`);
        writeFile("tools.ts", `export { requestSecretTool as askFirst } from "./source";\nexport { requestSecretTool as askSecond } from "./source";`);
        writeAgents(`
            import { askSecond } from "./tools";
            export const support = { ask: askSecond({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a tool a barrel re-exports as the default export", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export { requestSecretTool as default } from "@lunora/agent";`);
        writeAgents(`
            import ask from "./tools";
            export const support = { ask: ask({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a namespace a barrel re-exports with export * as, read for the tool", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export * as agent from "@lunora/agent";`);
        writeAgents(`
            import { agent } from "./tools";
            export const support = { ask: agent.requestSecretTool({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a namespace a barrel re-exports as its default export, read through the default import", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export * as default from "@lunora/agent";`);
        writeAgents(`
            import agent from "./tools";
            export const support = { ask: agent.requestSecretTool({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("detects a tool reached through two namespace barrels, read as a chain", () => {
        expect.assertions(1);

        writeFile("agent.ts", `export * as agent from "@lunora/agent";`);
        writeFile("tools.ts", `export * as tools from "./agent";`);
        writeAgents(`
            import { tools } from "./tools";
            export const support = { ask: tools.agent.requestSecretTool({ consumer: "charge", description: "d" }) };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(true);
    });

    it("does not treat a type-only reference to the tool as runtime use", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export * as agent from "@lunora/agent";`);
        writeAgents(`
            import { agent } from "./tools";
            export type SecretTool = typeof agent.requestSecretTool;
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("ignores a barrel that re-exports other names from the agent package", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export { defineAgent } from "@lunora/agent";`);
        writeAgents(`
            import { defineAgent } from "./tools";
            export const support = defineAgent({ model: "m", tools: {} });
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("ignores a barrel that re-exports the name from another package", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export { requestSecretTool } from "some-other-package";`);
        writeAgents(`
            import { requestSecretTool } from "./tools";
            export const support = { ask: requestSecretTool };
        `);

        expect(discoverSecretValueToolUsage(newProject(), workdir)).toBe(false);
    });

    it("ignores a type-only re-export of the name", () => {
        expect.assertions(1);

        writeFile("tools.ts", `export type { requestSecretTool } from "@lunora/agent";`);
        writeAgents(`
            import { requestSecretTool } from "./tools";
            export const support = { ask: requestSecretTool };
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
