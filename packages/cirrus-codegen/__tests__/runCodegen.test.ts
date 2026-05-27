import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCodegen } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");
const expectedDirectory = join(fixtureRoot, "expected", "_generated");

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-codegen-"));
    cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("runCodegen", () => {
    test("emits dataModel.ts with per-table Doc interfaces", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.dataModel).toContain('TableName = "messages" | "users"');
        expect(result.generated.dataModel).toContain("export interface Doc_messages");
        expect(result.generated.dataModel).toContain("export interface Doc_users");
        expect(result.generated.dataModel).toContain('_id: Id<"messages">');
        expect(result.generated.dataModel).toContain("channelId: Id<\"channels\">;");
        expect(result.generated.dataModel).toContain("text: string;");
    });

    test("emits api.ts with grouped queries/mutations", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.api).toContain("export interface ApiTypes");
        expect(result.generated.api).toContain("messages:");
        expect(result.generated.api).toContain('list: FunctionReference<"query"');
        expect(result.generated.api).toContain('send: FunctionReference<"mutation"');
        expect(result.generated.api).toContain('channelId: Id<"channels">');
        expect(result.generated.api).toContain("limit?: number");
        expect(result.generated.api).not.toContain("| undefined");
        expect(result.generated.api).toContain("export const api = anyApi as unknown as ApiTypes;");
    });

    test("emits server.ts that re-exports @cirrus/server factories", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.server).toContain('export { action, mutation, query } from "@cirrus/server"');
        expect(result.generated.server).toContain('export type { ActionCtx, MutationCtx, QueryCtx } from "@cirrus/server"');
    });

    test("writes all three files into _generated/", () => {
        runCodegen({ projectRoot: workdir });

        const generatedDirectory = join(workdir, "cirrus", "_generated");

        expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);
    });

    test("output matches committed expected/ files (snapshot)", () => {
        const result = runCodegen({ projectRoot: workdir });

        const expectedApi = readFileSync(join(expectedDirectory, "api.ts"), "utf8");
        const expectedServer = readFileSync(join(expectedDirectory, "server.ts"), "utf8");
        const expectedDataModel = readFileSync(join(expectedDirectory, "dataModel.ts"), "utf8");

        expect(result.generated.api).toBe(expectedApi);
        expect(result.generated.server).toBe(expectedServer);
        expect(result.generated.dataModel).toBe(expectedDataModel);
    });

    test("throws when schema.ts is missing", () => {
        const empty = mkdtempSync(join(tmpdir(), "cirrus-empty-"));

        try {
            expect(() => runCodegen({ projectRoot: empty })).toThrow(/schema\.ts not found/u);
        } finally {
            rmSync(empty, { force: true, recursive: true });
        }
    });
});
