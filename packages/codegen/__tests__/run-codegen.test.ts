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
        expect(result.generated.dataModel).toContain('channelId: Id<"channels">;');
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

    test("emits per-table index and searchIndex name unions in dataModel.ts", () => {
        const result = runCodegen({ projectRoot: workdir });

        // Indexes: messages -> "by_channel", users -> "by_email".
        expect(result.generated.dataModel).toContain("export interface IndexNamesByTable");
        expect(result.generated.dataModel).toContain('messages: "by_channel";');
        expect(result.generated.dataModel).toContain('users: "by_email";');
        expect(result.generated.dataModel).toContain("export type IndexName<T extends keyof DataModel>");

        // Search indexes: messages -> "by_text", users -> never.
        expect(result.generated.dataModel).toContain("export interface SearchIndexNamesByTable");
        expect(result.generated.dataModel).toContain('messages: "by_text";');
        expect(result.generated.dataModel).toContain("users: never;");
        expect(result.generated.dataModel).toContain("export type SearchIndexName<T extends keyof DataModel>");
    });

    test("emits literal validators as TS literal types and record as Record<K, V>", () => {
        const result = runCodegen({ projectRoot: workdir });

        // dataModel.ts: literal -> "admin", record -> Record<string, string>.
        expect(result.generated.dataModel).toContain('role: "admin";');
        expect(result.generated.dataModel).toContain("prefs: Record<string, string>;");

        // api.ts: literal inside a union -> "text" | "image"; record passes through.
        expect(result.generated.api).toContain('kind: "text" | "image"');
        expect(result.generated.api).toContain("tags: Record<string, string>");

        // Regression guard: if either kind ever falls through to the default
        // `unknown` we'd see the field type drop to `unknown`.
        expect(result.generated.api).not.toContain("kind: unknown");
        expect(result.generated.dataModel).not.toContain("prefs: unknown");
    });

    test("emits server.ts that re-exports @cirrus/server factories", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.server).toContain('export { action, mutation, query } from "@cirrus/server"');
        expect(result.generated.server).toContain('export type { ActionCtx, MutationCtx, QueryCtx } from "@cirrus/server"');
    });

    test("emits server.ts dispatch table keyed by `<namespace>:<fnName>`", () => {
        const result = runCodegen({ projectRoot: workdir });

        // The namespace must match the sanitized form `emitApi` uses so the
        // client-side `__cirrusRef` and the server-side dispatch key agree.
        expect(result.generated.server).toContain('import * as cirrus_messages_0 from "../messages.js"');
        expect(result.generated.server).toContain("export const CIRRUS_FUNCTIONS:");
        expect(result.generated.server).toContain('"messages:list": cirrus_messages_0.list');
        expect(result.generated.server).toContain('"messages:send": cirrus_messages_0.send');
        expect(result.generated.server).toContain("export const dispatchCirrusFunction =");
        expect(result.generated.server).toContain("FUNCTION_NOT_FOUND");
    });

    test("writes all generated files into _generated/", () => {
        runCodegen({ projectRoot: workdir });

        const generatedDirectory = join(workdir, "cirrus", "_generated");

        expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "drizzle.global.ts"))).toBe(true);
        expect(existsSync(join(generatedDirectory, "drizzle.shard.ts"))).toBe(true);
    });

    test("emits drizzle.global.ts containing only `.global()` tables", () => {
        const result = runCodegen({ projectRoot: workdir });

        // `users` is .global() — must appear here.
        expect(result.generated.drizzleGlobal).toContain('export const users = sqliteTable("users"');
        expect(result.generated.drizzleGlobal).toContain('uniqueIndex("by_email").on(t.email)');

        // `messages` is shardBy — must NOT appear in global file.
        expect(result.generated.drizzleGlobal).not.toContain('sqliteTable("messages"');
    });

    test("emits drizzle column mappings for optional/array/bigint/bytes", () => {
        const result = runCodegen({ projectRoot: workdir });

        // `attachments` table covers the long-tail validator → drizzle column mappings.
        expect(result.generated.drizzleGlobal).toContain('export const attachments = sqliteTable("attachments"');

        // v.bytes() → blob with mode: "buffer".
        expect(result.generated.drizzleGlobal).toContain('bytes: blob("bytes", { mode: "buffer" }).notNull()');

        // v.bigint() → blob with mode: "bigint".
        expect(result.generated.drizzleGlobal).toContain('size: blob("size", { mode: "bigint" }).notNull()');

        // v.array(...) → json text column with `.$type<Array<…>>()`.
        expect(result.generated.drizzleGlobal).toContain('tags: text("tags", { mode: "json" }).$type<Array<string>>().notNull()');

        // v.optional(...) drops `.notNull()`.
        expect(result.generated.drizzleGlobal).toContain('title: text("title"),');
        expect(result.generated.drizzleGlobal).not.toContain('title: text("title").notNull()');

        // v.id("users") inside a same-bucket table → `.references(() => users._id)`.
        expect(result.generated.drizzleGlobal).toContain('ownerId: text("ownerId").references(() => users._id).notNull()');
    });

    test("emits drizzle.shard.ts containing shardBy/root tables", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.drizzleShard).toContain('export const messages = sqliteTable("messages"');
        expect(result.generated.drizzleShard).toContain('index("by_channel").on(t.channelId)');

        // Implicit _id + _creationTime columns are always emitted.
        expect(result.generated.drizzleShard).toContain('_id: text("_id").primaryKey()');
        expect(result.generated.drizzleShard).toContain('_creationTime: integer("_creationTime").notNull()');

        // `users` is global — must NOT appear in shard file.
        expect(result.generated.drizzleShard).not.toContain('sqliteTable("users"');
    });

    test("output matches committed expected/ files (snapshot)", () => {
        const result = runCodegen({ projectRoot: workdir });

        const expectedApi = readFileSync(join(expectedDirectory, "api.ts"), "utf8");
        const expectedServer = readFileSync(join(expectedDirectory, "server.ts"), "utf8");
        const expectedDataModel = readFileSync(join(expectedDirectory, "dataModel.ts"), "utf8");
        const expectedDrizzleGlobal = readFileSync(join(expectedDirectory, "drizzle.global.ts"), "utf8");
        const expectedDrizzleShard = readFileSync(join(expectedDirectory, "drizzle.shard.ts"), "utf8");

        expect(result.generated.api).toBe(expectedApi);
        expect(result.generated.server).toBe(expectedServer);
        expect(result.generated.dataModel).toBe(expectedDataModel);
        expect(result.generated.drizzleGlobal).toBe(expectedDrizzleGlobal);
        expect(result.generated.drizzleShard).toBe(expectedDrizzleShard);
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
