import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runNewCommand } from "../../src/commands/new.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-new-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus new query|mutation|action", () => {
    test("creates a new query under cirrus/", () => {
        const result = runNewCommand({
            cwd: workdir,
            kind: "query",
            logger: silentLogger(),
            name: "listMessages",
        });

        expect(result.code).toBe(0);

        const file = join(workdir, "cirrus", "listMessages.ts");

        expect(existsSync(file)).toBe(true);

        const contents = readFileSync(file, "utf8");

        expect(contents).toContain('import { query, v } from "@cirrus/server"');
        expect(contents).toContain("export const listMessages = query({");
        expect(contents).toContain("args: {");
        expect(contents).toContain("handler:");
        expect(contents).toContain("ctx");
    });

    test("creates a mutation with the right import", () => {
        const result = runNewCommand({
            cwd: workdir,
            kind: "mutation",
            logger: silentLogger(),
            name: "send",
        });

        expect(result.code).toBe(0);

        const file = join(workdir, "cirrus", "send.ts");

        expect(existsSync(file)).toBe(true);

        const contents = readFileSync(file, "utf8");

        expect(contents).toContain('import { mutation, v } from "@cirrus/server"');
        expect(contents).toContain("mutation({");
    });

    test("creates an action and avoids the `db` mention in the body", () => {
        const result = runNewCommand({
            cwd: workdir,
            kind: "action",
            logger: silentLogger(),
            name: "callStripe",
        });

        expect(result.code).toBe(0);

        const file = join(workdir, "cirrus", "callStripe.ts");
        const contents = readFileSync(file, "utf8");

        expect(contents).toContain('import { action, v } from "@cirrus/server"');
        expect(contents).toContain("ctx.runQuery");
        expect(contents).toContain("ctx.runMutation");
    });

    test("rejects invalid identifiers", () => {
        const errors: string[] = [];

        const result = runNewCommand({
            cwd: workdir,
            kind: "query",
            logger: { ...silentLogger(), error: (message) => errors.push(message) },
            name: "1bad-name!",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toMatch(/invalid query name/u);
    });

    test("refuses to overwrite an existing file", () => {
        runNewCommand({ cwd: workdir, kind: "query", logger: silentLogger(), name: "dup" });

        const errors: string[] = [];
        const result = runNewCommand({
            cwd: workdir,
            kind: "query",
            logger: { ...silentLogger(), error: (m) => errors.push(m) },
            name: "dup",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("already exists");
    });

    test("converts dashed/underscored input to camelCase identifier and filename", () => {
        const result = runNewCommand({
            cwd: workdir,
            kind: "query",
            logger: silentLogger(),
            name: "list-messages-by-channel",
        });

        expect(result.code).toBe(0);

        const file = join(workdir, "cirrus", "listMessagesByChannel.ts");

        expect(existsSync(file)).toBe(true);
    });
});

describe("cirrus new table", () => {
    test("creates a brand-new schema.ts when none exists", () => {
        const result = runNewCommand({
            cwd: workdir,
            kind: "table",
            logger: silentLogger(),
            name: "users",
        });

        expect(result.code).toBe(0);

        const schema = readFileSync(join(workdir, "cirrus", "schema.ts"), "utf8");

        expect(schema).toContain('import { defineSchema, defineTable, v } from "@cirrus/server"');
        expect(schema).toMatch(/users:\s*defineTable\(/u);
    });

    test("appends a new table to an existing schema.ts", () => {
        const cirrusDirectory = join(workdir, "cirrus");

        mkdirSync(cirrusDirectory, { recursive: true });

        const initial = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

        writeFileSync(join(cirrusDirectory, "schema.ts"), initial, "utf8");

        const result = runNewCommand({
            cwd: workdir,
            kind: "table",
            logger: silentLogger(),
            name: "channels",
        });

        expect(result.code).toBe(0);

        const contents = readFileSync(join(cirrusDirectory, "schema.ts"), "utf8");

        // Both tables must remain.
        expect(contents).toMatch(/messages:\s*defineTable\(/u);
        expect(contents).toMatch(/channels:\s*defineTable\(/u);
    });

    test("refuses to add a duplicate table name", () => {
        const cirrusDirectory = join(workdir, "cirrus");

        mkdirSync(cirrusDirectory, { recursive: true });

        const initial = `import { defineSchema, defineTable } from "@cirrus/server";

export const schema = defineSchema({
    channels: defineTable({}),
});
`;

        writeFileSync(join(cirrusDirectory, "schema.ts"), initial, "utf8");

        const errors: string[] = [];

        const result = runNewCommand({
            cwd: workdir,
            kind: "table",
            logger: { ...silentLogger(), error: (m) => errors.push(m) },
            name: "channels",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("already exists");
    });
});

describe("cirrus new package", () => {
    test("refuses to run outside a monorepo", () => {
        // workdir has no pnpm-workspace.yaml above it (it's inside tmpdir).
        const errors: string[] = [];

        const result = runNewCommand({
            cwd: workdir,
            kind: "package",
            logger: { ...silentLogger(), error: (m) => errors.push(m) },
            name: "foo",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toMatch(/monorepo/u);
    });

    test("scaffolds the standard layout inside a fake monorepo", () => {
        // Create a minimal monorepo skeleton.
        writeFileSync(join(workdir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
        mkdirSync(join(workdir, "packages"), { recursive: true });

        const result = runNewCommand({
            cwd: workdir,
            kind: "package",
            logger: silentLogger(),
            name: "telemetry",
            description: "OpenTelemetry adapter",
            category: "observability",
        });

        expect(result.code).toBe(0);

        const target = join(workdir, "packages", "cirrus-telemetry");

        expect(existsSync(join(target, "package.json"))).toBe(true);
        expect(existsSync(join(target, "tsconfig.json"))).toBe(true);
        expect(existsSync(join(target, "vitest.config.ts"))).toBe(true);
        expect(existsSync(join(target, "packem.config.ts"))).toBe(true);
        expect(existsSync(join(target, "project.json"))).toBe(true);
        expect(existsSync(join(target, ".releaserc.json"))).toBe(true);
        expect(existsSync(join(target, "README.md"))).toBe(true);
        expect(existsSync(join(target, "src", "index.ts"))).toBe(true);

        const pkg = readFileSync(join(target, "package.json"), "utf8");

        expect(pkg).toContain('"name": "@cirrus/telemetry"');
        expect(pkg).toContain("OpenTelemetry adapter");

        const project = readFileSync(join(target, "project.json"), "utf8");

        expect(project).toContain('"name": "cirrus-telemetry"');
        expect(project).toContain('"category:observability"');
        expect(project).toContain('"type:package"');
    });
});
