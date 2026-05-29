import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { emitApi, emitDataModel, emitDrizzleSchema, emitServer, emitShard, runCodegen } from "../src/index.js";
import type { FunctionIR, SchemaIR } from "../src/ir.js";

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

    test("routes internal functions to `internal`/InternalApiTypes, keeping them off the public `api`", () => {
        const result = runCodegen({ projectRoot: workdir });

        // `purge` is an internalMutation — it must NOT appear in the public ApiTypes.
        const [publicHalf, internalHalf] = result.generated.api.split("export interface InternalApiTypes");

        expect(publicHalf).toContain("list:");
        expect(publicHalf).toContain("send:");
        expect(publicHalf).not.toContain("purge:");

        // …and it must appear in the internal half, typed as a mutation.
        expect(internalHalf).toContain('purge: FunctionReference<"mutation"');
        expect(result.generated.api).toContain("export const internal = anyApi as unknown as InternalApiTypes;");

        // The dispatch table still registers it (so `ctx.runMutation` can reach it),
        // and the external paths gate on `visibility`.
        expect(result.generated.server).toContain('"messages:purge": cirrus_messages_0.purge');
        expect(result.generated.server).toContain('visibility?: "internal" | "public";');
        expect(result.generated.shard).toContain('registered.visibility === "internal"');
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

    test("emits server.ts with project-typed query/mutation/action wrappers", () => {
        const result = runCodegen({ projectRoot: workdir });

        // The base factories are imported under `*Base` aliases and re-bound to
        // the schema-typed contexts (rather than re-exported verbatim).
        expect(result.generated.server).toContain("action as actionBase,");
        expect(result.generated.server).toContain("mutation as mutationBase,");
        expect(result.generated.server).toContain("query as queryBase,");
        expect(result.generated.server).toContain('} from "@cirrus/server";');
        expect(result.generated.server).toContain("export const query = queryBase as unknown as");
        expect(result.generated.server).toContain("export const mutation = mutationBase as unknown as");
        expect(result.generated.server).toContain("export const action = actionBase as unknown as");

        // Internal factories are re-bound to typed contexts alongside the public ones.
        expect(result.generated.server).toContain("internalQuery as internalQueryBase,");
        expect(result.generated.server).toContain("export const internalQuery = internalQueryBase as unknown as");
        expect(result.generated.server).toContain("export const internalMutation = internalMutationBase as unknown as");
        expect(result.generated.server).toContain("export const internalAction = internalActionBase as unknown as");

        // The typed contexts widen `db` to the generated per-table facade while
        // intersecting the legacy structural reader/writer for back-compat.
        expect(result.generated.server).toContain('export interface QueryCtx extends Omit<QueryCtxBase, "db">');
        expect(result.generated.server).toContain("readonly db: DatabaseReader & DatabaseReaderFacade;");
        expect(result.generated.server).toContain("readonly db: DatabaseWriter & DatabaseWriterFacade;");
        // `Id` is pulled into the facade import because the typed `Caller` arg
        // types reference it (the `messages:*` functions take `Id<"channels">`).
        expect(result.generated.server).toContain('import type { DatabaseReaderFacade, DatabaseWriterFacade, Id, OrmReader, OrmWriter } from "./dataModel.js"');
    });

    test("emits a typed createCaller covering public and internal functions", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.server).toContain("export type CallerCtx = ActionCtx | MutationCtx | QueryCtx;");
        expect(result.generated.server).toContain("export interface Caller {");
        expect(result.generated.server).toContain("export const createCaller = (context: CallerCtx): Caller =>");

        // Every leaf dispatches through the shared `callRegistered` helper.
        expect(result.generated.server).toContain('list: (args) => callRegistered(context, "messages:list", args),');

        // The caller reaches internal functions (server-to-server), unlike the
        // public `api`: `purge` (an internalMutation) is present here.
        expect(result.generated.server).toContain('purge: (args: { channelId: Id<"channels"> }) => Promise<unknown>;');
        expect(result.generated.server).toContain('purge: (args) => callRegistered(context, "messages:purge", args),');

        // Args are required when the function declares any, typed against dataModel.
        expect(result.generated.server).toContain('list: (args: { channelId: Id<"channels">; limit?: number }) => Promise<unknown>;');
    });

    test("emits per-table ctx.db facade types in dataModel.ts", () => {
        const result = runCodegen({ projectRoot: workdir });

        // Insert shapes — system fields optional, user fields carried through.
        expect(result.generated.dataModel).toContain("export interface Insert_messages");
        expect(result.generated.dataModel).toContain("export type Insert<T extends keyof DataModel>");

        // The typed `where` DSL + per-table reader/writer facades.
        expect(result.generated.dataModel).toContain("export interface WhereOperators<T>");
        expect(result.generated.dataModel).toContain("export type Where<TDoc>");
        expect(result.generated.dataModel).toContain("export interface TableReaderFacade<T extends keyof DataModel>");
        expect(result.generated.dataModel).toContain("export interface TableWriterFacade<T extends keyof DataModel>");
        expect(result.generated.dataModel).toContain("export type DatabaseReaderFacade");
        expect(result.generated.dataModel).toContain("export type DatabaseWriterFacade");
    });

    test("emits the ctx.orm namespace + findFirstOrThrow on the read facade", () => {
        const result = runCodegen({ projectRoot: workdir });

        // findFirstOrThrow joins the read facade alongside findFirst.
        expect(result.generated.dataModel).toContain("findFirstOrThrow:");

        // The kitcn-style ORM surfaces, all defined in dataModel.ts.
        expect(result.generated.dataModel).toContain("export interface OrmReader");
        expect(result.generated.dataModel).toContain("export interface OrmWriter extends OrmReader");
        expect(result.generated.dataModel).toContain("export interface OrmInsertBuilder<T extends keyof DataModel>");
        expect(result.generated.dataModel).toContain("export interface OrmUpdateBuilder<T extends keyof DataModel>");
        expect(result.generated.dataModel).toContain("export interface OrmReplaceBuilder<T extends keyof DataModel>");

        // Wired onto the typed contexts: reads get OrmReader, writes get OrmWriter.
        expect(result.generated.server).toContain("readonly orm: OrmReader;");
        expect(result.generated.server).toContain("readonly orm: OrmWriter;");

        // Runtime: bindTable gains findFirstOrThrow; bindOrm mirrors the facade into ctx.orm.
        expect(result.generated.shard).toContain("findFirstOrThrow: (args?: QueryArgs) => writer.findFirstOrThrow(tableName, args)");
        expect(result.generated.shard).toContain("const bindOrm = (facade:");
        expect(result.generated.shard).toContain("orm: bindOrm(facade),");
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
        expect(existsSync(join(generatedDirectory, "shard.ts"))).toBe(true);
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
        const expectedShard = readFileSync(join(expectedDirectory, "shard.ts"), "utf8");

        expect(result.generated.api).toBe(expectedApi);
        expect(result.generated.server).toBe(expectedServer);
        expect(result.generated.dataModel).toBe(expectedDataModel);
        expect(result.generated.drizzleGlobal).toBe(expectedDrizzleGlobal);
        expect(result.generated.drizzleShard).toBe(expectedDrizzleShard);
        expect(result.generated.shard).toBe(expectedShard);
    });

    test("emits shard.ts with a createShardDO factory wired to generated modules", () => {
        const result = runCodegen({ projectRoot: workdir });

        expect(result.generated.shard).toContain("export const createShardDO");
        expect(result.generated.shard).toContain('import { CIRRUS_FUNCTIONS, CIRRUS_MIGRATIONS } from "./server.js"');
        expect(result.generated.shard).toContain('import schema from "../schema.js"');
        expect(result.generated.shard).toContain("class extends ShardDOBase");
        expect(result.generated.shard).toContain("runShardMigrations");
        expect(result.generated.shard).toContain("createShardCtxDb");

        // The fixture schema declares no vector indexes, so the shard must stay
        // dependency-light and never reach for @cirrus/vectors.
        expect(result.generated.shard).not.toContain("@cirrus/vectors");
        expect(result.generated.shard).not.toContain("createVectorSyncHook");
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

describe("emitApi", () => {
    const fn = (overrides: Partial<FunctionIR>): FunctionIR => ({
        args: {},
        exportName: "list",
        filePath: "posts",
        kind: "query",
        returnType: "unknown",
        ...overrides,
    });

    test("imports Doc when a return type references it", () => {
        const output = emitApi([fn({ returnType: 'Doc<"posts">[]' })]);

        expect(output).toContain('import type { Doc } from "./dataModel.js";');
        expect(output).not.toContain("import type { Id }");
        expect(output).not.toContain("import type { Doc, Id }");
    });

    test("imports both Doc and Id when both are referenced", () => {
        const output = emitApi([fn({ args: { id: { kind: "id", tableName: "posts" } }, returnType: 'Doc<"posts">' })]);

        expect(output).toContain('import type { Doc, Id } from "./dataModel.js";');
    });

    test("imports only Id when no Doc is referenced", () => {
        const output = emitApi([fn({ args: { id: { kind: "id", tableName: "posts" } }, returnType: "{ ok: boolean }" })]);

        expect(output).toContain('import type { Id } from "./dataModel.js";');
        expect(output).not.toContain("Doc");
    });

    test("omits the dataModel import when neither is referenced", () => {
        const output = emitApi([fn({ returnType: "{ ok: boolean }" })]);

        expect(output).not.toContain("./dataModel.js");
    });
});

describe("emitShard", () => {
    test("wires @cirrus/vectors auto-sync when the schema declares vector indexes", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "docs",
                    relations: [],
                    searchIndexes: [],
                    shape: { body: { kind: "string" } },
                    shardMode: "root",
                    vectorIndexes: [{ field: "body", name: "by_body", table: "docs" }],
                },
            ],
            vectorIndexes: [{ field: "body", name: "by_body", table: "docs" }],
        };

        const output = emitShard(schema);

        // Vectors variant: pull the adapters + the Vectorize binding type.
        expect(output).toContain('import { createCtxVectors, createVectors, createVectorSyncHook } from "@cirrus/vectors"');
        expect(output).toContain("VectorizeIndexLike");
        expect(output).toContain("WriteHook");

        // ctx.vectors + the auto-propagation write hook are assembled in buildCtx.
        expect(output).toContain("vectors?: (env: Record<string, unknown>) => Record<string, VectorizeIndexLike>;");
        expect(output).toContain("onWrite = createVectorSyncHook(");
        expect(output).toContain("onWrite,");
        expect(output).toContain("vectors,");
    });

    test("omits @cirrus/vectors entirely when the schema declares no vectors", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "docs",
                    relations: [],
                    searchIndexes: [],
                    shape: { body: { kind: "string" } },
                    shardMode: "root",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        const output = emitShard(schema);

        expect(output).not.toContain("@cirrus/vectors");
        expect(output).not.toContain("createVectorSyncHook");
        expect(output).not.toContain("onWrite");
        expect(output).toContain("export const createShardDO");
    });

    test("binds `.global()` tables to the D1 facade and shard tables to the DO writer", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "messages",
                    relations: [],
                    searchIndexes: [],
                    shape: { text: { kind: "string" } },
                    shardMode: { field: "channelId", kind: "shardBy" },
                    vectorIndexes: [],
                },
                {
                    indexes: [],
                    name: "users",
                    relations: [],
                    searchIndexes: [],
                    shape: { email: { kind: "string" } },
                    shardMode: "global",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        const output = emitShard(schema);

        // The D1 config thunk + fallback stub appear only because a `.global()` table exists.
        expect(output).toContain("d1?: (env: Record<string, unknown>) => DatabaseWriterLike;");
        expect(output).toContain("const globalDbStub: DatabaseWriterLike");
        expect(output).toContain("const globalDb: DatabaseWriterLike = config.d1?.(env) ?? globalDbStub;");

        // Backend selection by shardMode: shard table → DO writer, global table → D1 facade.
        expect(output).toContain('facade["messages"] = bindTable(db, "messages");');
        expect(output).toContain('facade["users"] = bindTable(globalDb, "users");');
    });

    test("omits the D1 facade plumbing when no table is `.global()`", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "messages",
                    relations: [],
                    searchIndexes: [],
                    shape: { text: { kind: "string" } },
                    shardMode: "root",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        const output = emitShard(schema);

        expect(output).not.toContain("globalDbStub");
        expect(output).not.toContain("config.d1");
        expect(output).not.toContain("d1?:");
        expect(output).toContain('facade["messages"] = bindTable(db, "messages");');
    });

    test("hoists the scheduler and threads it into createShardCtxDb for triggers", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "messages",
                    relations: [],
                    searchIndexes: [],
                    shape: { text: { kind: "string" } },
                    shardMode: "root",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        const output = emitShard(schema);

        // The scheduler is resolved once, typed for the ctx-db options surface.
        expect(output).toContain("SchedulerLike");
        expect(output).toContain("const scheduler = (config.scheduler?.(env) ?? schedulerStub) as SchedulerLike;");

        // It is passed into the ORM writer (so DO triggers get ctx.scheduler) and reused on ctx via shorthand.
        const dbOptions = output.slice(output.indexOf("createShardCtxDb({"), output.indexOf("createShardCtxDb({") + 400);

        expect(dbOptions).toContain("scheduler,");
    });
});

describe("emitServer", () => {
    const fn = (exportName: string, overrides: Partial<FunctionIR> = {}): FunctionIR => ({
        args: {},
        exportName,
        filePath: "posts",
        kind: "query",
        returnType: "unknown",
        ...overrides,
    });

    test("renders the caller arg as optional only when the function takes none", () => {
        const output = emitServer([fn("ping"), fn("get", { args: { id: { kind: "id", tableName: "posts" } } })]);

        expect(output).toContain("ping: (args?: {}) => Promise<unknown>;");
        expect(output).toContain('get: (args: { id: Id<"posts"> }) => Promise<unknown>;');
    });

    test("threads a function's concrete return type through the caller", () => {
        const output = emitServer([fn("count", { returnType: "number" })]);

        expect(output).toContain("count: (args?: {}) => Promise<number>;");
        expect(output).toContain('count: (args) => callRegistered(context, "posts:count", args),');
    });

    test("emits an empty caller (and no unused locals) when there are no functions", () => {
        const output = emitServer([]);

        // No functions ⇒ no `callRegistered` helper and the `context` parameter
        // is prefixed so it never trips noUnusedParameters in a real project.
        expect(output).toContain("export interface Caller {}");
        expect(output).toContain("export const createCaller = (_context: CallerCtx): Caller => ({});");
        expect(output).not.toContain("const callRegistered");

        // Nothing references Doc/Id, so the facade import stays minimal (ORM types are always pulled in).
        expect(output).toContain('import type { DatabaseReaderFacade, DatabaseWriterFacade, OrmReader, OrmWriter } from "./dataModel.js";');
    });
});

describe("timestamp/date column kinds", () => {
    const schema: SchemaIR = {
        tables: [
            {
                indexes: [],
                name: "events",
                relations: [],
                searchIndexes: [],
                shape: { at: { kind: "timestamp" }, due: { kind: "date" } },
                shardMode: "root",
                vectorIndexes: [],
            },
        ],
        vectorIndexes: [],
    };

    test("renders timestamp/date as epoch-millisecond numbers in dataModel.ts", () => {
        const output = emitDataModel(schema);

        expect(output).toContain("at: number;");
        expect(output).toContain("due: number;");
    });

    test("maps timestamp/date to integer drizzle columns", () => {
        const { shard } = emitDrizzleSchema(schema);

        expect(shard).toContain('at: integer("at").notNull()');
        expect(shard).toContain('due: integer("due").notNull()');
    });
});
