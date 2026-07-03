import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAiToolSideEffects from "../src/discover-ai-tool-side-effects";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverAiToolSideEffects", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ai-tool-side-effects-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a side-effecting tool with user-derived input (bare args.x)", () => {
        expect.assertions(2);

        write(
            "agent.ts",
            `export const run = action(async ({ ctx, args }) => generateText({
    model: ctx.ai.model("m"),
    prompt: args.prompt,
    tools: { save: tool({ execute: async ({ text }) => ctx.db.insert("notes", { text }) }) },
}));`,
        );

        const rows = discoverAiToolSideEffects(project, join(workdir, "lunora"));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ method: "generateText", sideEffect: "ctx.db.insert", userInputDerived: true });
    });

    it("flags input destructured from args (args: { question })", () => {
        expect.assertions(1);

        write(
            "agent.ts",
            `export const run = action(async ({ ctx, args: { question } }) => streamText({
    model: ctx.ai.model("m"),
    messages: [{ role: "user", content: question }],
    tools: { call: tool({ execute: async () => ctx.runMutation(api.x, {}) }) },
}));`,
        );

        const [row] = discoverAiToolSideEffects(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ method: "streamText", sideEffect: "ctx.runMutation", userInputDerived: true });
    });

    it("records userInputDerived=false for a fully server-authored prompt", () => {
        expect.assertions(1);

        write(
            "agent.ts",
            `export const run = action(async ({ ctx }) => generateText({
    model: ctx.ai.model("m"),
    prompt: "summarize the system status",
    tools: { send: tool({ execute: async () => ctx.fetch("https://api.example.com") }) },
}));`,
        );

        const [row] = discoverAiToolSideEffects(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ sideEffect: "ctx.fetch", userInputDerived: false });
    });

    it("does not track a generation whose tools have no privileged side effect", () => {
        expect.assertions(1);

        write(
            "agent.ts",
            `export const run = action(async ({ ctx, args }) => generateText({
    model: ctx.ai.model("m"),
    prompt: args.prompt,
    tools: { lookup: tool({ execute: async ({ id }) => ctx.db.query("notes").get(id) }) },
}));`,
        );

        expect(discoverAiToolSideEffects(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not track a generation with no tools", () => {
        expect.assertions(1);

        write("agent.ts", `export const run = action(async ({ ctx, args }) => generateText({ model: ctx.ai.model("m"), prompt: args.prompt }));`);

        expect(discoverAiToolSideEffects(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
