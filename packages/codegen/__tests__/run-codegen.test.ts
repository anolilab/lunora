import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitApi, emitDataModel, emitDrizzleSchema, emitFunctions, emitServer, emitShard, runCodegen } from "../src/index.js";
import type { FunctionIR, SchemaIR } from "../src/ir.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");
const expectedDirectory = join(fixtureRoot, "expected", "_generated");
const SCHEMA_NOT_FOUND_RE = /schema\.ts not found/u;

let workdir: string;

describe("run-codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-codegen-"));
        cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("runCodegen", () => {
        it("emits dataModel.ts with per-table Doc interfaces", () => {
            expect.assertions(6);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.dataModel).toContain('TableName = "messages" | "users"');
            expect(result.generated.dataModel).toContain("export interface Doc_messages");
            expect(result.generated.dataModel).toContain("export interface Doc_users");
            expect(result.generated.dataModel).toContain('_id: Id<"messages">');
            expect(result.generated.dataModel).toContain('channelId: Id<"channels">;');
            expect(result.generated.dataModel).toContain("text: string;");
        });

        it("emits api.ts with grouped queries/mutations", () => {
            expect.assertions(8);

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

        it("routes internal functions to `internal`/InternalApiTypes, keeping them off the public `api`", () => {
            expect.assertions(8);

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
            expect(result.generated.functions).toContain('"messages:purge": cirrus_messages_0.purge');
            expect(result.generated.functions).toContain('visibility?: "internal" | "public";');
            expect(result.generated.shard).toContain('registered.visibility === "internal"');
        });

        it("emits per-table index and searchIndex name unions in dataModel.ts", () => {
            expect.assertions(8);

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

        it("emits literal validators as TS literal types and record as Record<K, V>", () => {
            expect.assertions(6);

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

        it("emits server.ts with project-typed query/mutation/action wrappers", () => {
            expect.assertions(17);

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
            // server.ts is the builder file user code imports, so it must NOT import
            // the user function modules (that cycle lives in functions.ts). `Id as
            // IdOfTable` + `TableName` back the typed `v.id(...)`.
            expect(result.generated.server).not.toContain("import * as cirrus_");
            expect(result.generated.server).toContain(
                'import type { DatabaseReaderFacade, DatabaseWriterFacade, Id as IdOfTable, OrmReader, OrmWriter, TableName } from "./dataModel.js"',
            );
            // The typed `v` whose `id(...)` autocompletes the schema's tables.
            // eslint-disable-next-line no-secrets/no-secrets -- generated TS type signature, not a credential
            expect(result.generated.server).toContain("id: <T extends TableName>(table: T) => ColumnValidator<IdOfTable<T>, IdOfTable<T>>;");
        });

        it("emits a typed createCaller covering public and internal functions", () => {
            expect.assertions(7);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.functions).toContain("export type CallerCtx = ActionCtx | MutationCtx | QueryCtx;");
            expect(result.generated.functions).toContain("export interface Caller {");
            expect(result.generated.functions).toContain("export const createCaller = (context: CallerCtx): Caller =>");

            // Every leaf dispatches through the shared `callRegistered` helper.
            expect(result.generated.functions).toContain('list: (args) => callRegistered(context, "messages:list", args),');

            // The caller reaches internal functions (server-to-server), unlike the
            // public `api`: `purge` (an internalMutation) is present here.
            expect(result.generated.functions).toContain('purge: (args: { channelId: Id<"channels"> }) => Promise<unknown>;');
            expect(result.generated.functions).toContain('purge: (args) => callRegistered(context, "messages:purge", args),');

            // Args are required when the function declares any, typed against dataModel.
            expect(result.generated.functions).toContain('list: (args: { channelId: Id<"channels">; limit?: number }) => Promise<unknown>;');
        });

        it("emits per-table ctx.db facade types in dataModel.ts", () => {
            expect.assertions(9);

            const result = runCodegen({ projectRoot: workdir });

            // Insert shapes — system fields optional, user fields carried through.
            expect(result.generated.dataModel).toContain("export interface Insert_messages");
            expect(result.generated.dataModel).toContain("export type Insert<T extends keyof DataModel>");

            // The typed `where` DSL is re-exported from the shipped
            // `@cirrus/server/data-model` module; the per-table reader/writer
            // facades are bound to this project's maps.
             
            expect(result.generated.dataModel).toContain('from "@cirrus/server/data-model";');
            expect(result.generated.dataModel).toContain("    Where,\n    WhereOperators,");
            expect(result.generated.dataModel).toContain("export type TableReaderFacade<T extends keyof DataModel> = TableReaderFacadeOf<");
            expect(result.generated.dataModel).toContain("export type TableWriterFacade<T extends keyof DataModel> = TableWriterFacadeOf<");
            expect(result.generated.dataModel).toContain("export type DatabaseReaderFacade = DatabaseReaderFacadeOf<");
            expect(result.generated.dataModel).toContain("export type DatabaseWriterFacade = DatabaseWriterFacadeOf<");

            // Typed full-text search support is re-exported (the SearchReader /
            // SearchFilterBuilder bodies live in the shipped module now).
            expect(result.generated.dataModel).toContain("    SearchFilterBuilder,\n    SearchReader,");
             
        });

        it("emits the ctx.orm namespace bound to the shipped facade generics", () => {
            expect.assertions(11);

            const result = runCodegen({ projectRoot: workdir });

            // The read facade (with findFirstOrThrow) is bound from the shipped
            // module rather than emitted inline.
            expect(result.generated.dataModel).toContain("= TableReaderFacadeOf<");

            // The kitcn-style ORM surfaces stay generated (they wire Insert/Id).
            expect(result.generated.dataModel).toContain("export interface OrmReader");
            expect(result.generated.dataModel).toContain("export interface OrmWriter extends OrmReader");
            expect(result.generated.dataModel).toContain("export interface OrmInsertBuilder<T extends keyof DataModel>");
            expect(result.generated.dataModel).toContain("export interface OrmUpdateBuilder<T extends keyof DataModel>");
            expect(result.generated.dataModel).toContain("export interface OrmReplaceBuilder<T extends keyof DataModel>");

            // Wired onto the typed contexts: reads get OrmReader, writes get OrmWriter.
            expect(result.generated.server).toContain("readonly orm: OrmReader;");
            expect(result.generated.server).toContain("readonly orm: OrmWriter;");

            // Runtime: the facade binding is the shared `@cirrus/server` helper
            // (one source of truth with the RLS middleware), and `ctx.orm` is
            // built from it via `bindOrm`.
            expect(result.generated.shard).toContain('import { bindOrm, bindTableFacade } from "@cirrus/server";');
            expect(result.generated.shard).toContain("= bindTableFacade(");
            expect(result.generated.shard).toContain("orm: bindOrm(facade),");
        });

        it("emits functions.ts dispatch table keyed by `<namespace>:<fnName>`", () => {
            expect.assertions(6);

            const result = runCodegen({ projectRoot: workdir });

            // The namespace must match the sanitized form `emitApi` uses so the
            // client-side `__cirrusRef` and the server-side dispatch key agree.
            expect(result.generated.functions).toContain('import * as cirrus_messages_0 from "../messages.js"');
            expect(result.generated.functions).toContain("export const CIRRUS_FUNCTIONS:");
            expect(result.generated.functions).toContain('"messages:list": cirrus_messages_0.list');
            expect(result.generated.functions).toContain('"messages:send": cirrus_messages_0.send');
            expect(result.generated.functions).toContain("export const dispatchCirrusFunction =");
            expect(result.generated.functions).toContain("FUNCTION_NOT_FOUND");
        });

        it("writes all generated files into _generated/", () => {
            expect.assertions(7);

            runCodegen({ projectRoot: workdir });

            const generatedDirectory = join(workdir, "cirrus", "_generated");

            expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "functions.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "drizzle.global.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "drizzle.shard.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "shard.ts"))).toBe(true);
        });

        it("emits drizzle.global.ts containing only `.global()` tables", () => {
            expect.assertions(3);

            const result = runCodegen({ projectRoot: workdir });

            // `users` is .global() — must appear here.
            expect(result.generated.drizzleGlobal).toContain('export const users = sqliteTable("users"');
            expect(result.generated.drizzleGlobal).toContain('uniqueIndex("by_email").on(t.email)');

            // `messages` is shardBy — must NOT appear in global file.
            expect(result.generated.drizzleGlobal).not.toContain('sqliteTable("messages"');
        });

        it("emits drizzle column mappings for optional/array/bigint/bytes", () => {
            expect.assertions(7);

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

        it("emits drizzle.shard.ts containing shardBy/root tables", () => {
            expect.assertions(5);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.drizzleShard).toContain('export const messages = sqliteTable("messages"');
            expect(result.generated.drizzleShard).toContain('index("by_channel").on(t.channelId)');

            // Implicit _id + _creationTime columns are always emitted.
            expect(result.generated.drizzleShard).toContain('_id: text("_id").primaryKey()');
            expect(result.generated.drizzleShard).toContain('_creationTime: integer("_creationTime").notNull()');

            // `users` is global — must NOT appear in shard file.
            expect(result.generated.drizzleShard).not.toContain('sqliteTable("users"');
        });

        it("output matches committed expected/ files (snapshot)", () => {
            expect.assertions(7);

            const result = runCodegen({ projectRoot: workdir });

            const expectedApi = readFileSync(join(expectedDirectory, "api.ts"), "utf8");
            const expectedServer = readFileSync(join(expectedDirectory, "server.ts"), "utf8");
            const expectedFunctions = readFileSync(join(expectedDirectory, "functions.ts"), "utf8");
            const expectedDataModel = readFileSync(join(expectedDirectory, "dataModel.ts"), "utf8");
            const expectedDrizzleGlobal = readFileSync(join(expectedDirectory, "drizzle.global.ts"), "utf8");
            const expectedDrizzleShard = readFileSync(join(expectedDirectory, "drizzle.shard.ts"), "utf8");
            const expectedShard = readFileSync(join(expectedDirectory, "shard.ts"), "utf8");

            expect(result.generated.api).toBe(expectedApi);
            expect(result.generated.server).toBe(expectedServer);
            expect(result.generated.functions).toBe(expectedFunctions);
            expect(result.generated.dataModel).toBe(expectedDataModel);
            expect(result.generated.drizzleGlobal).toBe(expectedDrizzleGlobal);
            expect(result.generated.drizzleShard).toBe(expectedDrizzleShard);
            expect(result.generated.shard).toBe(expectedShard);
        });

        it("emits shard.ts with a createShardDO factory wired to generated modules", () => {
            expect.assertions(8);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).toContain("export const createShardDO");
            expect(result.generated.shard).toContain('import { CIRRUS_FUNCTIONS, CIRRUS_MIGRATIONS } from "./functions.js"');
            expect(result.generated.shard).toContain('import schema from "../schema.js"');
            expect(result.generated.shard).toContain("class extends ShardDOBase");
            expect(result.generated.shard).toContain("runShardMigrations");
            expect(result.generated.shard).toContain("createShardCtxDb");

            // The fixture schema declares no vector indexes, so the shard must stay
            // dependency-light and never reach for @cirrus/vectors.
            expect(result.generated.shard).not.toContain("@cirrus/vectors");
            expect(result.generated.shard).not.toContain("createVectorSyncHook");
        });

        it("throws when schema.ts is missing", () => {
            expect.assertions(1);

            const empty = mkdtempSync(join(tmpdir(), "cirrus-empty-"));

            try {
                expect(() => runCodegen({ projectRoot: empty })).toThrow(SCHEMA_NOT_FOUND_RE);
            } finally {
                rmSync(empty, { force: true, recursive: true });
            }
        });
    });

    describe("emitApi", () => {
        const makeFunction = (overrides: Partial<FunctionIR>): FunctionIR => {
            return {
                args: {},
                exportName: "list",
                filePath: "posts",
                kind: "query",
                returnType: "unknown",
                ...overrides,
            };
        };

        it("imports Doc when a return type references it", () => {
            expect.assertions(3);

            const output = emitApi([makeFunction({ returnType: 'Doc<"posts">[]' })]);

            expect(output).toContain('import type { Doc } from "./dataModel.js";');
            expect(output).not.toContain("import type { Id }");
            expect(output).not.toContain("import type { Doc, Id }");
        });

        it("imports both Doc and Id when both are referenced", () => {
            expect.assertions(1);

            const output = emitApi([makeFunction({ args: { id: { kind: "id", tableName: "posts" } }, returnType: 'Doc<"posts">' })]);

            expect(output).toContain('import type { Doc, Id } from "./dataModel.js";');
        });

        it("imports only Id when no Doc is referenced", () => {
            expect.assertions(2);

            const output = emitApi([makeFunction({ args: { id: { kind: "id", tableName: "posts" } }, returnType: "{ ok: boolean }" })]);

            expect(output).toContain('import type { Id } from "./dataModel.js";');
            expect(output).not.toContain("Doc");
        });

        it("omits the dataModel import when neither is referenced", () => {
            expect.assertions(1);

            const output = emitApi([makeFunction({ returnType: "{ ok: boolean }" })]);

            expect(output).not.toContain("./dataModel.js");
        });
    });

    describe("emitShard", () => {
        it("wires @cirrus/vectors auto-sync when the schema declares vector indexes", () => {
            expect.assertions(7);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "docs",
                        rankIndexes: [],
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

        it("omits @cirrus/vectors entirely when the schema declares no vectors", () => {
            expect.assertions(4);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "docs",
                        rankIndexes: [],
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

        it("binds `.global()` tables to the D1 facade and shard tables to the DO writer", () => {
            expect.assertions(6);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "messages",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { text: { kind: "string" } },
                        shardMode: { field: "channelId", kind: "shardBy" },
                        vectorIndexes: [],
                    },
                    {
                        indexes: [],
                        name: "users",
                        rankIndexes: [],
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
            expect(output).toContain("d1?: (env: Record<string, unknown>) => DatabaseWriterLike | undefined;");
            expect(output).toContain("const globalDbStub: DatabaseWriterLike");
            expect(output).toContain("const globalDb: DatabaseWriterLike = config.d1?.(env) ?? globalDbStub;");

            // `globalDb` is passed into the shard ctx-db so the generic
            // `ctx.db.insert("<global>", …)`/`query`/… methods route to D1 (not just
            // the property-style `ctx.db.<global>` facade).
            expect(output).toContain("\n                globalDb,");

            // Backend selection by shardMode: shard table → DO writer, global table → D1 facade.
            expect(output).toContain('facade["messages"] = bindTableFacade(db, "messages");');
            expect(output).toContain('facade["users"] = bindTableFacade(globalDb, "users");');
        });

        it("omits the D1 facade plumbing when no table is `.global()`", () => {
            expect.assertions(4);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "messages",
                        rankIndexes: [],
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
            expect(output).toContain('facade["messages"] = bindTableFacade(db, "messages");');
        });

        it("hoists the scheduler and threads it into createShardCtxDb for triggers", () => {
            expect.assertions(3);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "messages",
                        rankIndexes: [],
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
            const databaseOptions = output.slice(output.indexOf("createShardCtxDb({"), output.indexOf("createShardCtxDb({") + 400);

            expect(databaseOptions).toContain("scheduler,");
        });
    });

    describe("emitServer", () => {
        it("re-exports the builders without importing any user function module", () => {
            expect.assertions(5);

            const output = emitServer();

            // server.ts is the file user code imports for `v`/`query`/`mutation`.
            // It must never import the user function modules — otherwise the
            // module-init cycle that crashes dev (`v` reads as undefined) returns.
            expect(output).not.toContain("import * as cirrus_");
            expect(output).not.toContain("CIRRUS_FUNCTIONS");
            expect(output).toContain("export const v = vBase as unknown as");
            expect(output).toContain("export const mutation = mutationBase as unknown as");
            // The facade import stays minimal (ORM types are always pulled in).
            expect(output).toContain(
                'import type { DatabaseReaderFacade, DatabaseWriterFacade, Id as IdOfTable, OrmReader, OrmWriter, TableName } from "./dataModel.js";',
            );
        });
    });

    describe("emitFunctions", () => {
        const makeFunction = (exportName: string, overrides: Partial<FunctionIR> = {}): FunctionIR => {
            return {
                args: {},
                exportName,
                filePath: "posts",
                kind: "query",
                returnType: "unknown",
                ...overrides,
            };
        };

        it("imports ctx types from server.js as type-only (no runtime cycle)", () => {
            expect.assertions(2);

            const output = emitFunctions([makeFunction("ping")]);

            // functions.ts imports the user modules, so its edge back to server.ts
            // must be type-only — otherwise the two form a runtime cycle again.
            expect(output).toContain('import type { ActionCtx, MutationCtx, QueryCtx } from "./server.js";');
            expect(output).toContain('import * as cirrus_posts_0 from "../posts.js";');
        });

        it("renders the caller arg as optional only when the function takes none", () => {
            expect.assertions(2);

            const output = emitFunctions([makeFunction("ping"), makeFunction("get", { args: { id: { kind: "id", tableName: "posts" } } })]);

            expect(output).toContain("ping: (args?: {}) => Promise<unknown>;");
            expect(output).toContain('get: (args: { id: Id<"posts"> }) => Promise<unknown>;');
        });

        it("threads a function's concrete return type through the caller", () => {
            expect.assertions(2);

            const output = emitFunctions([makeFunction("count", { returnType: "number" })]);

            expect(output).toContain("count: (args?: {}) => Promise<number>;");
            expect(output).toContain('count: (args) => callRegistered(context, "posts:count", args),');
        });

        it("emits an empty caller (and no unused locals) when there are no functions", () => {
            expect.assertions(4);

            const output = emitFunctions([]);

            // No functions ⇒ no `callRegistered` helper and the `context` parameter
            // is prefixed so it never trips noUnusedParameters in a real project.
            expect(output).toContain("export interface Caller {}");
            expect(output).toContain("export const createCaller = (_context: CallerCtx): Caller => ({});");
            expect(output).not.toContain("const callRegistered");

            // Nothing references Doc/Id, so the dataModel import is omitted entirely.
            expect(output).not.toContain("./dataModel.js");
        });
    });

    describe("timestamp/date column kinds", () => {
        const schema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "events",
                    rankIndexes: [],
                    relations: [],
                    searchIndexes: [],
                    shape: { at: { kind: "timestamp" }, due: { kind: "date" } },
                    shardMode: "root",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        it("renders timestamp/date as epoch-millisecond numbers in dataModel.ts", () => {
            expect.assertions(2);

            const output = emitDataModel(schema);

            expect(output).toContain("at: number;");
            expect(output).toContain("due: number;");
        });

        it("maps timestamp/date to integer drizzle columns", () => {
            expect.assertions(2);

            const { shard } = emitDrizzleSchema(schema);

            expect(shard).toContain('at: integer("at").notNull()');
            expect(shard).toContain('due: integer("due").notNull()');
        });
    });
});
