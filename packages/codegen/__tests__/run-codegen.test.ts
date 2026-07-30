import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createCodegenProject,
    emitApi,
    emitDataModel,
    emitDrizzleSchema,
    emitFunctions,
    emitServer,
    emitShard,
    emitVectors,
    refreshCodegenProject,
    runCodegen,
} from "../src/index";
import type { FunctionIR, SchemaIR, ShapeIR } from "../src/ir";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");
const expectedDirectory = join(fixtureRoot, "expected", "_generated");
const SCHEMA_NOT_FOUND_RE = /schema\.ts not found/u;

/**
 * Slice a single `export interface &lt;Name> ... { ... }` block out of emitted
 * `server.ts` so a ctx-augmentation assertion can scope to exactly one context
 * (e.g. assert a field is on `ActionCtx` but absent from `QueryCtx`).
 */
const ctxInterface = (server: string, name: "ActionCtx" | "MutationCtx" | "QueryCtx"): string => {
    const start = server.indexOf(`export interface ${name} `);
    const open = server.indexOf("{", start);
    const close = server.indexOf("\n}", open);

    return server.slice(open, close);
};

let workdir: string;

describe("run-codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
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

        it("narrows ctx.db.asId to a real TableName", () => {
            expect.assertions(5);

            const result = runCodegen({ projectRoot: workdir });

            // The conditional `AsIdTable` is what makes a misspelled literal fail. An
            // intersection with a wide `(string, string) => string` overload would look
            // narrowed but silently fall through for a bad literal — verified by probe —
            // so assert the emitted form has no such overload.
            expect(result.generated.server).toContain("type AsIdTable<T extends string> = T extends TableName ? T : string extends T ? T : never;");
            expect(result.generated.server).toContain("type TypedAsId = <T extends string>(tableName: AsIdTable<T>, id: string) => IdOfTable<T & TableName>;");
            expect(result.generated.server).not.toContain("(tableName: string, id: string) => string)");
            expect(ctxInterface(result.generated.server, "QueryCtx")).toContain("asId: TypedAsId");
            // Overridden, so the wide `<T extends string>` signature is omitted first.
            expect(result.generated.server).toContain('Omit<DatabaseReader, "asId" | "query" | "get">');
        });

        it("excludes an add-on's tables from AppTableName while keeping them in TableName", () => {
            expect.assertions(4);

            // Replace the fixture schema with one that pulls in an extension, the shape
            // `.extend(ratelimit.extension)` produces in a real app.
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                `import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

export default defineSchema({
    nodes: defineTable({ text: v.string() }),
}).extend(
    defineSchemaExtension("ratelimit", {
        tables: { buckets: defineTable({ key: v.string() }) },
    }),
);
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            // The add-on's table is real and queryable…
            expect(result.generated.dataModel).toContain('TableName = "nodes" | "ratelimit_buckets"');
            expect(result.generated.dataModel).toContain("export interface Doc_ratelimit_buckets");
            // …but an app enumerating its own tables never has to mention it.
            expect(result.generated.dataModel).toContain('AppTableName = "nodes"');
            expect(result.generated.dataModel).not.toContain('AppTableName = "nodes" | "ratelimit_buckets"');
        });

        it("rejects a workflow and an agent that share a deployed name (CODEGEN-01 cross-kind)", () => {
            expect.assertions(1);

            // discoverWorkflows/discoverAgents each dedup WITHIN their own kind,
            // but both land in the exact same wrangler workflows[] array — a
            // collision across kinds must be rejected before reconcile, not left
            // to fail late in wrangler or silently clobber a binding.
            writeFileSync(
                join(workdir, "lunora", "workflows.ts"),
                `
                import { defineWorkflow } from "@lunora/workflow";
                export const sweep = defineWorkflow({ handler: async () => undefined, name: "shared-name" });
            `,
            );
            writeFileSync(
                join(workdir, "lunora", "agents.ts"),
                `
                import { defineAgent } from "@lunora/agent";
                export const support = defineAgent({ model: "m", name: "shared-name" });
            `,
            );

            expect(() => runCodegen({ projectRoot: workdir })).toThrow(/Duplicate deployed name "shared-name"/u);
        });

        it("is silent and output-unchanged when LUNORA_CODEGEN_TIMING is unset", () => {
            expect.assertions(3);

            const priorFlag = process.env["LUNORA_CODEGEN_TIMING"];
            // eslint-disable-next-line no-console -- capture the opt-in timing line under test.
            const originalError = console.error;
            const errors: string[] = [];

            // eslint-disable-next-line no-console -- temporarily intercept the diagnostic line.
            console.error = (...arguments_: unknown[]): void => {
                errors.push(arguments_.map(String).join(" "));
            };

            let withFlag: ReturnType<typeof runCodegen>;
            let withoutFlag: ReturnType<typeof runCodegen>;

            try {
                delete process.env["LUNORA_CODEGEN_TIMING"];
                withoutFlag = runCodegen({ projectRoot: workdir });

                process.env["LUNORA_CODEGEN_TIMING"] = "1";
                withFlag = runCodegen({ projectRoot: workdir });
            } finally {
                // eslint-disable-next-line no-console -- restore the original implementation.
                console.error = originalError;

                if (priorFlag === undefined) {
                    delete process.env["LUNORA_CODEGEN_TIMING"];
                } else {
                    process.env["LUNORA_CODEGEN_TIMING"] = priorFlag;
                }
            }

            // Exactly one diagnostic line — emitted by the flagged run only.
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatch(/@lunora\/codegen: codegen took \d+ms \(discovery \d+ms, emit \d+ms\)/u);
            // The instrumentation is side-effect-free on the generated output.
            expect(withFlag.generated).toStrictEqual(withoutFlag.generated);
        });

        it("does not wire @lunora/ai for a project that doesn't use it", () => {
            expect.assertions(2);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).not.toContain("@lunora/ai");
            expect(result.generated.server).not.toContain("@lunora/ai");
        });

        it("imports base packages directly when the project depends on the granular @lunora/* packages", () => {
            expect.assertions(6);

            // No package.json (or one without `lunora`) → granular form, the default.
            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.server).toContain('from "@lunora/server"');
            expect(result.generated.dataModel).toContain('from "@lunora/server/data-model"');
            expect(result.generated.api).toContain('from "@lunora/server/types"');
            expect(result.generated.api).toContain('from "@lunora/client"');
            expect(result.generated.shard).toContain('from "@lunora/do"');
            expect(result.generated.drizzleShard).toContain('from "@lunora/server/drizzle"');
        });

        it("imports base packages through the lunorash umbrella subpaths when the project depends on `lunorash`", () => {
            expect.assertions(9);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*", lunorash: "*" }, name: "umbrella-app" }));

            const result = runCodegen({ projectRoot: workdir });

            // Base surface routed through the umbrella…
            expect(result.generated.server).toContain('from "lunorash/server"');
            expect(result.generated.dataModel).toContain('from "lunorash/server/data-model"');
            expect(result.generated.api).toContain('from "lunorash/server/types"');
            expect(result.generated.api).toContain('from "lunorash/client"');
            expect(result.generated.shard).toContain('from "lunorash/do"');
            expect(result.generated.drizzleShard).toContain('from "lunorash/server/drizzle"');
            // …and never the granular base specifiers.
            expect(result.generated.server).not.toContain('from "@lunora/server"');
            expect(result.generated.shard).not.toContain('from "@lunora/do"');
            expect(result.generated.api).not.toContain('from "@lunora/client"');
        });

        describe("local-first sync engine (shapes, mutators, collections)", () => {
            const writeShapes = (): void => {
                writeFileSync(
                    join(workdir, "lunora", "shapes.ts"),
                    `import { defineShape, v } from "@lunora/server";
export const channelMessages = defineShape({
    table: "messages",
    args: { channelId: v.id("channels") },
    columns: ["channelId", "text"],
    where: (_ctx, args) => ({ channelId: args.channelId }),
});
`,
                    "utf8",
                );
            };

            const writeMutators = (): void => {
                writeFileSync(
                    join(workdir, "lunora", "mutators.ts"),
                    `import { defineMutator, v } from "@lunora/server";
export const sendMessage = defineMutator({
    args: { channelId: v.id("channels"), text: v.string() },
    server: async (_ctx, args) => ({ channelId: args.channelId, text: args.text }),
    client: (_tx, _args) => {},
});
`,
                    "utf8",
                );
            };

            it("registers shapes into LUNORA_SHAPES and overrides resolveShape on the DO", () => {
                expect.assertions(10);

                writeShapes();

                const result = runCodegen({ lint: false, projectRoot: workdir });

                // functions.ts gains the shape registry, keyed by export name.
                expect(result.generated.functions).toContain("export const LUNORA_SHAPES");
                expect(result.generated.functions).toContain('"channelMessages":');
                // The generated DO resolves shape subscriptions against the registry.
                expect(result.generated.shard).toContain("LUNORA_SHAPES");
                expect(result.generated.shard).toContain("protected override resolveShape");
                expect(result.generated.shard).toContain("compileWhere");
                // The cross-shard-join guard is imported + called against the compiled predicate.
                expect(result.generated.shard).toContain("assertShapeShardable");
                expect(result.generated.shard).toContain("assertShapeShardable(effectiveWhere, schema as unknown as SchemaLike, shape.table)");
                // The shape predicate is AND-merged with the table's RLS read base-where:
                // a module-scope registry is built from the function table, the helper is
                // imported, and the resolver composes it before the shardability guard.
                // eslint-disable-next-line no-secrets/no-secrets -- asserting on generated TS, not a credential
                expect(result.generated.shard).toContain("const LUNORA_RLS_READ_REGISTRY = buildRlsReadRegistry(Object.values(LUNORA_FUNCTIONS));");
                expect(result.generated.shard).toContain("buildRlsReadRegistry, composeShapeReadWhere");
                // eslint-disable-next-line no-secrets/no-secrets -- asserting on generated TS, not a credential
                expect(result.generated.shard).toContain("composeShapeReadWhere(LUNORA_RLS_READ_REGISTRY,");
            });

            it("registers mutators into the dispatch table + LUNORA_MUTATOR_PATHS and overrides isCustomMutator", () => {
                expect.assertions(4);

                writeMutators();

                const result = runCodegen({ lint: false, projectRoot: workdir });

                // Mutators register into the function dispatch table (transaction-wrapped),
                // keyed by their file-scoped path.
                expect(result.generated.functions).toContain('"mutators:sendMessage"');
                expect(result.generated.functions).toContain("export const LUNORA_MUTATOR_PATHS");
                // The generated DO routes the push/watermark protocol through the override.
                expect(result.generated.shard).toContain("LUNORA_MUTATOR_PATHS");
                expect(result.generated.shard).toContain("protected override isCustomMutator");
            });

            it("emits each mutator as a typed api.mutators.<name> reference so a client serverRef is compile-checked", () => {
                expect.assertions(3);

                writeMutators();

                const result = runCodegen({ lint: false, projectRoot: workdir });

                // `defineMutator({ serverRef: api.mutators.sendMessage })` in the browser
                // bundle now binds the dispatch path at compile time (and infers its args
                // from the server mutator's validators) instead of restating the
                // `"mutators:sendMessage"` string nothing checks.
                expect(result.generated.api).toContain("    mutators: {");
                expect(result.generated.api).toContain('sendMessage: FunctionReference<"mutation",');
                // A mutator is client-pushed, so it belongs on the public surface — not
                // the server-only `internal` one.
                expect(result.generated.api.split("export const api")[1]).not.toContain("sendMessage");
            });

            it("emits _generated/collections.ts (options factory + collection per shape) when @lunora/db is a dependency", () => {
                expect.assertions(9);

                writeShapes();
                writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/db": "*" }, name: "db-app" }));

                const result = runCodegen({ lint: false, projectRoot: workdir });

                expect(result.generated.collections).toContain('import { lunoraCollectionOptions } from "@lunora/db/collections"');
                expect(result.generated.collections).toContain('import type { LunoraClient, SubscriptionError } from "@lunora/client"');
                // The composable form returns `checkpoints` + `scope`, so an app with
                // custom mutators can actually use what codegen produced.
                expect(result.generated.collections).toContain("export const channelMessagesCollectionOptions");
                expect(result.generated.collections).toContain("export const channelMessagesCollection");
                // eslint-disable-next-line no-secrets/no-secrets -- a generated TS type name, not a credential
                expect(result.generated.collections).toContain('LunoraCollectionOptions<Doc<"messages"> & Row>');
                expect(result.generated.collections).toContain('name: "channelMessages"');
                // The shape's own validators type its partition selector, instead of the
                // caller passing an opaque `Record<string, unknown>`.
                expect(result.generated.collections).toContain('args: { channelId: Id<"channels"> };');
                // `shardKey` reaches the subscription (a `.shardBy()` table needs it for
                // the watermark to land in the right bucket) and `getKey` is overridable.
                expect(result.generated.collections).toContain("shardKey?: string;");
                expect(result.generated.collections).toContain('getKey?: (row: Doc<"messages"> & Row) => string;');
            });

            it("routes the collection client import through the umbrella but keeps @lunora/db scoped", () => {
                expect.assertions(3);

                writeShapes();
                writeFileSync(
                    join(workdir, "package.json"),
                    JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/db": "*", lunorash: "*" }, name: "umbrella-db-app" }),
                );

                const result = runCodegen({ lint: false, projectRoot: workdir });

                // @lunora/client is in the umbrella base → remapped.
                expect(result.generated.collections).toContain('import type { LunoraClient, SubscriptionError } from "lunorash/client"');
                // @lunora/db is an opt-in add-on → stays scoped even under the umbrella.
                expect(result.generated.collections).toContain('from "@lunora/db/collections"');
                expect(result.generated.collections).not.toContain('from "lunorash/db');
            });

            it("does not emit collections.ts when shapes exist but @lunora/db is absent", () => {
                expect.assertions(2);

                writeShapes();

                const result = runCodegen({ lint: false, projectRoot: workdir });

                expect(result.generated.collections).toBe("");
                expect(existsSync(join(workdir, "lunora", "_generated", "collections.ts"))).toBe(false);
            });

            it("prunes a stale collections.ts when the @lunora/db feature is later removed", () => {
                expect.assertions(3);

                const collectionsPath = join(workdir, "lunora", "_generated", "collections.ts");

                // Feature present: shapes + @lunora/db → collections.ts is written to disk.
                writeShapes();
                writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/db": "*" }, name: "db-app" }));
                runCodegen({ lint: false, projectRoot: workdir });

                expect(existsSync(collectionsPath)).toBe(true);

                // Feature removed: drop the @lunora/db dependency. The emitter now
                // returns "" and the prior file must be deleted, not left dangling
                // (it imports @lunora/db, which the app no longer installs).
                writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*" }, name: "db-app" }));

                const result = runCodegen({ lint: false, projectRoot: workdir });

                expect(result.generated.collections).toBe("");
                expect(existsSync(collectionsPath)).toBe(false);
            });

            it("leaves generated output byte-identical when neither shapes nor mutators are declared", () => {
                expect.assertions(3);

                const baseline = runCodegen({ lint: false, projectRoot: workdir }).generated;

                expect(baseline.collections).toBe("");
                expect(baseline.functions).not.toContain("LUNORA_SHAPES");
                expect(baseline.functions).not.toContain("LUNORA_MUTATOR_PATHS");
            });
        });

        describe("typed identity layer (defineIdentity)", () => {
            const writeIdentity = (): void => {
                writeFileSync(
                    join(workdir, "lunora", "identity.ts"),
                    `import { defineIdentity, v } from "@lunora/server";
export const identity = defineIdentity({
    userId: v.string(),
    tenantId: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
});
`,
                    "utf8",
                );
            };

            it("leaves server.ts byte-identical when no defineIdentity is declared", () => {
                expect.assertions(6);

                const { server } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // No contract ⇒ none of the narrowing fragments are emitted, so the
                // output is the untyped-identity baseline (the guardrail the item
                // was deferred to protect).
                expect(server).not.toContain("InferIdentity");
                expect(server).not.toContain("lunoraIdentityContract");
                expect(server).not.toContain("export type Identity");
                expect(server).not.toContain("NarrowedAuth");
                // The RLS DSL keeps the untyped-identity default binding.
                expect(server).toContain("export const definePolicy = createPolicyDsl<DataModel, Relations>();");
                // ctx.auth is inherited from the base (never re-declared / omitted).
                expect(server).not.toContain('"db" | "storage" | "auth"');
            });

            it("narrows ctx.auth.getIdentity() + the RLS policy identity to the declared contract", () => {
                expect.assertions(9);

                writeIdentity();

                const { server } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // The claim type is recovered from the declaration itself (reused
                // `InferIdentity` machinery, `typeof` the imported contract) — no
                // parallel type system, no runtime import.
                expect(server).toContain('import type { InferIdentity } from "@lunora/server";');
                expect(server).toContain('import type * as lunoraIdentityContract from "../identity.js";');
                expect(server).toContain("export type Identity = InferIdentity<typeof lunoraIdentityContract.identity>;");
                // `getIdentity()` narrows to `Identity | null` via a NarrowedAuth override.
                expect(server).toContain('type NarrowedAuth = Omit<QueryCtxBase["auth"], "getIdentity"> & { getIdentity: () => Promise<Identity | null> };');
                expect(server).toContain("readonly auth: NarrowedAuth;");
                // Each ctx omits the base `auth` so the narrowed one replaces it.
                expect(ctxInterface(server, "QueryCtx")).toContain("readonly auth: NarrowedAuth;");
                expect(ctxInterface(server, "ActionCtx")).toContain("readonly auth: NarrowedAuth;");
                expect(server).toContain('export interface QueryCtx extends Omit<QueryCtxBase, "db" | "storage" | "auth">');
                // The RLS DSL is bound to the declared identity so a policy's
                // `ctx.auth.identity` narrows to it.
                expect(server).toContain("export const definePolicy = createPolicyDsl<DataModel, Relations, Identity>();");
            });

            it("leaves app.ts free of identity wiring when no defineIdentity is declared", () => {
                expect.assertions(2);

                const { app } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // No contract ⇒ no import and no `options.identity` wiring, so the
                // runtime trust boundary is a no-op. (An unrelated `identity:` may
                // appear inside the D1 global-db factory, so we assert on the
                // contract-specific fragments rather than the bare substring.)
                expect(app).not.toContain("lunoraIdentityContract");
                expect(app).not.toContain(`from "../identity.js"`);
            });

            it("wires options.identity into app.ts so the trust boundary validates in the generated worker", () => {
                expect.assertions(3);

                writeIdentity();

                const { app } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // Imported as a VALUE (not `import type`) — the contract must exist
                // at runtime for the worker's contract gate to run.
                expect(app).toContain('import * as lunoraIdentityContract from "../identity.js";');
                expect(app).not.toContain("import type * as lunoraIdentityContract");
                // Wired onto the worker options the runtime validates against.
                expect(app).toContain("identity: lunoraIdentityContract.identity,");
            });

            it("errors when more than one defineIdentity is declared", () => {
                expect.assertions(1);

                writeFileSync(
                    join(workdir, "lunora", "identity.ts"),
                    `import { defineIdentity, v } from "@lunora/server";
export const identity = defineIdentity({ userId: v.string() });
export const other = defineIdentity({ userId: v.string() });
`,
                    "utf8",
                );

                expect(() => runCodegen({ lint: false, projectRoot: workdir })).toThrow(/exactly one is allowed/u);
            });
        });

        describe("typed env layer (defineEnv)", () => {
            const writeEnv = (specifier = "@lunora/server"): void => {
                writeFileSync(
                    join(workdir, "lunora", "env.ts"),
                    `import { defineEnv, v } from "${specifier}";
export const env = defineEnv({
    STRIPE_KEY: v.string(),
    PORT: v.optional(v.number()),
});
`,
                    "utf8",
                );
            };

            it("leaves server.ts + shard.ts byte-identical when no defineEnv is declared", () => {
                expect.assertions(4);

                const { server, shard } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // No contract ⇒ none of the wiring fragments are emitted, so the
                // output is the baseline (guards the golden-fixture invariant).
                expect(server).not.toContain("lunoraEnvContract");
                expect(server).not.toContain("export type LunoraEnv");
                expect(shard).not.toContain("lunoraEnvContract");
                expect(shard).not.toContain("envConfig");
            });

            it("types ctx.env as the validated shape on every ctx when the project declares lunora/env.ts", () => {
                expect.assertions(6);

                writeEnv();

                const { server } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // The validated shape is recovered from the declaration itself
                // (`ReturnType` over the accessor's `typeof` — no parallel type
                // system, no runtime import in server.ts).
                expect(server).toContain('import type * as lunoraEnvContract from "../env.js";');
                expect(server).toContain("export type LunoraEnv = ReturnType<typeof lunoraEnvContract.env>;");
                // ctx.env is typed on EVERY ctx (query/mutation/action).
                expect(ctxInterface(server, "QueryCtx")).toContain("readonly env: LunoraEnv;");
                expect(ctxInterface(server, "MutationCtx")).toContain("readonly env: LunoraEnv;");
                expect(ctxInterface(server, "ActionCtx")).toContain("readonly env: LunoraEnv;");
                // Each ctx omits the base optional `env` so the narrowed one replaces it.
                expect(server).toContain('export interface QueryCtx extends Omit<QueryCtxBase, "db" | "storage" | "env">');
            });

            it("wires ctx.env end-to-end in the ShardDO by applying the accessor to the worker env", () => {
                expect.assertions(4);

                writeEnv();

                const { shard } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // Imported as a VALUE namespace (the accessor must run at ctx-build time).
                expect(shard).toContain('import * as lunoraEnvContract from "../env.js";');
                expect(shard).toContain("const envConfig = lunoraEnvContract.env(env);");
                // Rides every ctx, so it is spliced into the shared ctx literal…
                expect(shard).toContain("\n                env: envConfig,");
                // …never gated behind the action-only block.
                expect(shard).not.toContain("ctx.env = envConfig;");
            });

            it("routes ctx.env types through the lunorash umbrella when the accessor is imported from lunorash/server", () => {
                expect.assertions(2);

                writeEnv("lunorash/server");

                const { server, shard } = runCodegen({ lint: false, projectRoot: workdir }).generated;

                // The contract module is always `../env.js` regardless of the umbrella —
                // it is the user's own module, not a base-package specifier.
                expect(server).toContain("export type LunoraEnv = ReturnType<typeof lunoraEnvContract.env>;");
                expect(shard).toContain("const envConfig = lunoraEnvContract.env(env);");
            });

            it("errors when more than one defineEnv is declared", () => {
                expect.assertions(1);

                writeFileSync(
                    join(workdir, "lunora", "env.ts"),
                    `import { defineEnv, v } from "@lunora/server";
export const env = defineEnv({ PORT: v.number() });
export const other = defineEnv({ HOST: v.string() });
`,
                    "utf8",
                );

                expect(() => runCodegen({ lint: false, projectRoot: workdir })).toThrow(/exactly one is allowed/u);
            });
        });

        it("wires ctx.ai end-to-end when a function reads ctx.ai", () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "lunora", "summarize.ts"),
                `import { action, v } from "@lunora/server";
export const summarize = action({ args: { text: v.string() }, handler: async (ctx, { text }) => ctx.ai.model("@cf/meta/llama-3.1-8b-instruct") });
`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).toContain('import { createAi } from "@lunora/ai"');
            expect(result.generated.shard).toContain("ai,");
            expect(result.generated.server).toContain("readonly ai: LunoraAi;");
        });

        it("does not wire @lunora/payment for a project that doesn't use it", () => {
            expect.assertions(2);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).not.toContain("@lunora/payment");
            expect(result.generated.server).not.toContain("@lunora/payment");
        });

        it("wires ctx.payments end-to-end when a function reads ctx.payments", () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "lunora", "billing.ts"),
                `import { action, v } from "@lunora/server";
export const mySubs = action({ args: { reference: v.string() }, handler: async (ctx, { reference }) => ctx.payments.listSubscriptions(reference) });
`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).toContain('import { paymentsFromContext } from "@lunora/payment"');
            expect(result.generated.shard).toContain("payments,");
            expect(result.generated.shard).toContain("paymentStub");
            expect(result.generated.server).toContain("readonly payments: LunoraPayment;");
        });

        it("wires ctx.kv end-to-end (every ctx) when a query reads ctx.kv", () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "lunora", "cache.ts"),
                `import { query, v } from "@lunora/server";
export const cached = query({ args: { key: v.string() }, handler: async (ctx, { key }) => ctx.kv.get(key) });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import { createKv } from "@lunora/bindings/kv"');
            expect(result.generated.shard).toContain("\n                kv,");
            // KV rides every ctx, so it must NOT be gated behind the action-only block.
            expect(result.generated.shard).not.toContain("ctx.kv = kv;");
            expect(result.generated.server).toContain('readonly kv: import("@lunora/bindings/kv").Kv;');
        });

        it("wires ctx.access end-to-end (every ctx) when a query reads ctx.access", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "lunora", "whoami.ts"),
                `import { query } from "@lunora/server";
export const whoAmI = query({ args: {}, handler: async (ctx) => ({ email: ctx.access.email, isOps: ctx.access.hasGroup("ops") }) });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import { accessFacade } from "@lunora/cloudflare-access/context"');
            expect(result.generated.shard).toContain("const access = accessFacade(identity, userId);");
            expect(result.generated.shard).toContain("\n                access,");
            // Access rides every ctx, so it must NOT be gated behind the action-only block.
            expect(result.generated.shard).not.toContain("ctx.access = access;");
            expect(result.generated.server).toContain('readonly access: import("@lunora/cloudflare-access/context").AccessFacade;');
        });

        it("does not wire ctx.access for a project that doesn't read it", () => {
            expect.assertions(2);

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).not.toContain("@lunora/cloudflare-access");
            expect(result.generated.server).not.toContain("@lunora/cloudflare-access");
        });

        it("does not wire @lunora/flags for a project without a lunora/flags.ts", () => {
            expect.assertions(2);

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).not.toContain("@lunora/flags");
            expect(result.generated.server).not.toContain("@lunora/flags");
        });

        it("wires ctx.flags end-to-end (every ctx) when the project declares lunora/flags.ts", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "lunora", "flags.ts"),
                `import { defineFlags } from "@lunora/flags";
export default defineFlags({ provider: (env) => env.PROVIDER, identify: (auth) => auth.userId ?? undefined });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import { createFlags } from "@lunora/flags"');
            expect(result.generated.shard).toContain('import flagsConfig from "../flags.js"');
            expect(result.generated.shard).toContain("\n                flags,");
            // Flags ride every ctx, so they must NOT be gated behind the action-only block.
            expect(result.generated.shard).not.toContain("ctx.flags = flags;");
            expect(result.generated.server).toContain('readonly flags: import("@lunora/flags").LunoraFlags;');
        });

        it("routes ctx.flags imports through the lunorash umbrella when the project depends on `lunorash`", () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*", lunorash: "*" }, name: "umbrella-flags-app" }));
            writeFileSync(
                join(workdir, "lunora", "flags.ts"),
                `import { defineFlags } from "lunorash/flags";
export default defineFlags({ provider: (env) => env.PROVIDER, identify: (auth) => auth.userId ?? undefined });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            // Flags surface routed through the umbrella…
            expect(result.generated.shard).toContain('import { createFlags } from "lunorash/flags"');
            expect(result.generated.server).toContain('readonly flags: import("lunorash/flags").LunoraFlags;');
            // …and never the granular `@lunora/flags` specifier (the pre-fix bug).
            expect(result.generated.shard).not.toContain("@lunora/flags");
            expect(result.generated.server).not.toContain("@lunora/flags");
        });

        it("does not wire @lunora/notify for a project without a lunora/notify.ts (default-closed)", () => {
            expect.assertions(4);

            // The `simple` fixture ships a `lunora/notify.ts` (golden coverage); remove
            // it to assert the default-closed path emits neither facade.
            rmSync(join(workdir, "lunora", "notify.ts"), { force: true });

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).not.toContain("@lunora/notify");
            expect(result.generated.shard).not.toContain("createNotify");
            expect(result.generated.server).not.toContain("@lunora/notify");
            // Default-closed: neither the notify nor the push ctx field is emitted.
            expect(result.generated.server).not.toContain("LunoraNotify");
        });

        it("wires ctx.notify + its ctx.push alias end-to-end (every ctx) when the project declares lunora/notify.ts", () => {
            expect.assertions(7);

            writeFileSync(
                join(workdir, "lunora", "notify.ts"),
                `import { defineNotify, webPushFromEnv } from "@lunora/notify";
export default defineNotify({ webPush: (env) => webPushFromEnv(env) });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            // Runtime wiring (shard): the definition import + createNotify build + both ctx fields.
            expect(result.generated.shard).toContain('import { createNotify } from "@lunora/notify"');
            expect(result.generated.shard).toContain('import notifyConfig from "../notify.js"');
            // The facade is threaded `ctx.log` / `ctx.metrics` for delivery observability.
            expect(result.generated.shard).toContain("const { notify, push } = createNotify(notifyConfig, env, { log, metrics });");
            expect(result.generated.shard).toContain("\n                notify,\n                push,");
            // Notify rides every ctx, so it must NOT be gated behind the action-only block.
            expect(result.generated.shard).not.toContain("ctx.notify = notify;");
            // Type wiring (server): both facades typed via @lunora/notify (never umbrella-remapped).
            expect(result.generated.server).toContain('readonly notify: import("@lunora/notify").LunoraNotify;');
            expect(result.generated.server).toContain('readonly push: import("@lunora/notify").LunoraPush;');
        });

        it("wires ctx.notify (every ctx) even under the lunorash umbrella — @lunora/notify is an add-on, never remapped", () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*", lunorash: "*" }, name: "umbrella-notify-app" }));
            writeFileSync(
                join(workdir, "lunora", "notify.ts"),
                `import { defineNotify, webPushFromEnv } from "@lunora/notify";
export default defineNotify({ webPush: (env) => webPushFromEnv(env) });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import { createNotify } from "@lunora/notify"');
            expect(result.generated.server).toContain('import("@lunora/notify").LunoraNotify');
            // Never a `lunorash/notify` subpath — notify has no umbrella re-export.
            expect(result.generated.shard).not.toContain("lunorash/notify");
        });

        it("wires ctx.sql (Hyperdrive) end-to-end onto the ActionCtx ONLY (value-level) when an action reads ctx.sql", () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "lunora", "external.ts"),
                `import { action, v } from "@lunora/server";
export const ext = action({ args: { id: v.string() }, handler: async (ctx, { id }) => ctx.sql.query("select 1") });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import type { SqlClient } from "@lunora/hyperdrive";');
            // Attached only inside the `if (isAction)` block — never spliced into the shared ctx literal.
            expect(result.generated.shard).toContain("ctx.sql = sql;");

            const baseCtxBody = result.generated.shard.slice(0, result.generated.shard.indexOf("const isAction ="));

            expect(baseCtxBody).not.toContain("\n                sql,");
            expect(result.generated.server).toContain('readonly sql: import("@lunora/hyperdrive").SqlClient;');
        });

        it("wires ctx.r2sql (R2 SQL) end-to-end onto the ActionCtx ONLY (value-level) when an action reads ctx.r2sql", () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "lunora", "analytics.ts"),
                `import { action, v } from "@lunora/server";
export const top = action({ args: { region: v.string() }, handler: async (ctx, { region }) => ctx.r2sql.from("s.orders").select("id").run() });
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.shard).toContain('import { createR2Sql } from "@lunora/bindings/r2sql";');
            // Attached only inside the `if (isAction)` block — never spliced into the shared ctx literal.
            expect(result.generated.shard).toContain("ctx.r2sql = r2sql;");

            const baseCtxBody = result.generated.shard.slice(0, result.generated.shard.indexOf("const isAction ="));

            expect(baseCtxBody).not.toContain("\n                r2sql,");
            expect(result.generated.server).toContain('readonly r2sql: import("@lunora/bindings/r2sql").R2SqlClient;');
        });

        it("gates studioFeatures end-to-end: payments on (ctx read), crons drive scheduler, storage column drives storage, mail/vectors off", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "lunora", "billing.ts"),
                `import { action, v } from "@lunora/server";
export const mySubs = action({ args: { reference: v.string() }, handler: async (ctx, { reference }) => ctx.payments.listSubscriptions(reference) });
`,
                "utf8",
            );
            writeFileSync(
                join(workdir, "lunora", "crons.ts"),
                `import { cronJobs } from "@lunora/scheduler";
import { internal } from "./_generated/api.js";
const crons = cronJobs();
crons.cron("ping", "0 * * * *", internal.messages.list, {});
export default crons;
`,
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            // payments via ctx read; scheduler via a declared cron (no @lunora/scheduler ctx use needed);
            // storage via the fixture's `attachments.fileKey: v.storage()` column (no ctx.storage use needed).
            expect(result.generated.shard).toContain('"payments": true');
            expect(result.generated.shard).toContain('"scheduler": true');
            expect(result.generated.shard).toContain('"storage": true');
            // The fixture app declares no mail or vector usage, so those stay hidden.
            expect(result.generated.shard).toContain('"mail": false');
            expect(result.generated.shard).toContain('"vectors": false');
        });

        it("does not emit a seed client for a project that doesn't depend on @lunora/seed", () => {
            expect.assertions(1);

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.seed).toBe("");
        });

        it("emits a project-bound seed client when @lunora/seed is a declared dependency", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "*" }, devDependencies: { "@lunora/seed": "workspace:*" }, name: "demo" }),
                "utf8",
            );

            const result = runCodegen({ lint: false, projectRoot: workdir });

            expect(result.generated.seed).toContain('import { createSeedClient as createSeedClientBase } from "@lunora/seed";');
            // The runtime schema is the default export of lunora/schema.ts (same import the ShardDO uses).
            expect(result.generated.seed).toContain('import schema from "../schema.js";');
            expect(result.generated.seed).toContain('import type { InsertModel } from "./dataModel.js";');
            // InsertModel is pre-bound and the schema pre-applied, so callers pass only options.
            expect(result.generated.seed).toContain(
                "export const createSeedClient = (options?: SeedClientOptions): SeedClient<InsertModel> => createSeedClientBase<InsertModel>(schema, options);",
            );
            expect(result.generated.seed).not.toContain("| undefined");
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
            expect(result.generated.functions).toContain('"messages:purge": lunora_messages_0.purge');
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
            expect.assertions(15);

            const result = runCodegen({ projectRoot: workdir });

            // The procedure builders come from `initLunora.dataModel<DataModel>().create()`
            // and are re-bound to the schema-typed contexts via the exported builder types.
            expect(result.generated.server).toContain(
                'import { createPolicyDsl, defineMutator as defineMutatorBase, initLunora, v as vBase } from "@lunora/server";',
            );
            expect(result.generated.server).toContain("const lunoraBuilders = initLunora.dataModel<DataModel>().create();");
            // The relation-aware RLS authoring DSL is bound to this schema's maps.
            expect(result.generated.server).toContain("export const definePolicy = createPolicyDsl<DataModel, Relations>();");
            expect(result.generated.server).toContain("export const query = lunoraBuilders.query as unknown as QueryBuilder<QueryCtx, EmptyArgs>;");
            expect(result.generated.server).toContain("export const mutation = lunoraBuilders.mutation as unknown as MutationBuilder<MutationCtx, EmptyArgs>;");
            expect(result.generated.server).toContain("export const action = lunoraBuilders.action as unknown as ActionBuilder<ActionCtx, EmptyArgs>;");

            // Internal builders are re-bound to typed contexts alongside the public ones.
            expect(result.generated.server).toContain(
                "export const internalQuery = lunoraBuilders.internalQuery as unknown as InternalQueryBuilder<QueryCtx, EmptyArgs>;",
            );
            expect(result.generated.server).toContain(
                "export const internalMutation = lunoraBuilders.internalMutation as unknown as InternalMutationBuilder<MutationCtx, EmptyArgs>;",
            );
            expect(result.generated.server).toContain(
                "export const internalAction = lunoraBuilders.internalAction as unknown as InternalActionBuilder<ActionCtx, EmptyArgs>;",
            );

            // The typed contexts widen `db` to the generated per-table facade while
            // intersecting the legacy structural reader/writer for back-compat.
            expect(result.generated.server).toContain('export interface QueryCtx extends Omit<QueryCtxBase, "db" | "storage">');
            expect(result.generated.server).toContain(
                'readonly db: Omit<DatabaseReader, "asId" | "query" | "get"> & DatabaseReaderFacade & { asId: TypedAsId; query: TypedTableQuery; get: TypedTableGet };',
            );
            expect(result.generated.server).toContain(
                'readonly db: Omit<DatabaseWriter, "asId" | "query" | "get"> & DatabaseWriterFacade & { asId: TypedAsId; query: TypedTableQuery; get: TypedTableGet };',
            );
            // server.ts is the builder file user code imports, so it must NOT import
            // the user function modules (that cycle lives in functions.ts). `Id as
            // IdOfTable` + `TableName` back the typed `v.id(...)`.
            expect(result.generated.server).not.toContain("import * as lunora_");
            expect(result.generated.server).toContain(
                'import type { DataModel, DatabaseReaderFacade, DatabaseWriterFacade, Doc, Id as IdOfTable, OrmReader, OrmWriter, Relations, TableName } from "./dataModel.js"',
            );
            // The typed `v` whose `id(...)` autocompletes the schema's tables.
            // eslint-disable-next-line no-secrets/no-secrets -- generated TS type signature, not a credential
            expect(result.generated.server).toContain("id: <T extends TableName>(table: T) => ColumnValidator<IdOfTable<T>, IdOfTable<T>>;");
        });

        it("narrows ctx.storage to the declared bucket names", () => {
            expect.assertions(3);

            const result = runCodegen({ projectRoot: workdir });

            // `StorageBucketName` is emitted (at minimum the default bucket) and
            // `ctx.storage` is narrowed to it on every context.
            expect(result.generated.server).toContain('export type StorageBucketName = "default"');
            // eslint-disable-next-line no-secrets/no-secrets -- generated TS type annotation, not a secret
            expect(result.generated.server).toContain("readonly storage: ReadOnlyStorage<StorageBucketName>;");

            expect(result.generated.server).toContain("readonly storage: StorageBase<StorageBucketName>;");
        });

        it("unions storage-rule buckets into StorageBucketName even with no v.storage column", () => {
            expect.assertions(2);

            // No schema storage columns; a rule references the "exports" bucket — it
            // must still be addressable via `ctx.storage.bucket("exports")`.
            const server = emitServer({ schema: { tables: [], vectorIndexes: [] }, storageRuleBuckets: ["exports", "avatars"] });

            expect(server).toContain('export type StorageBucketName = "default" | "avatars" | "exports"');
            // De-duped + "default" always first.
            expect(server).not.toContain('"default" | "default"');
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
            // `@lunora/server/data-model` module; the per-table reader/writer
            // facades are bound to this project's maps.

            expect(result.generated.dataModel).toContain('from "@lunora/server/data-model";');
            expect(result.generated.dataModel).toContain("    Where,\n    WhereOf,\n    WhereOperators,");
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

            // Runtime: the facade binding is the shared `@lunora/server` helper
            // (one source of truth with the RLS middleware), and `ctx.orm` is
            // built from it via `bindOrm`.
            expect(result.generated.shard).toContain('import { bindOrm, bindTableFacade } from "@lunora/server";');
            expect(result.generated.shard).toContain("= bindTableFacade(");
            expect(result.generated.shard).toContain("orm: bindOrm(facade),");
        });

        it("emits functions.ts dispatch table keyed by `<namespace>:<fnName>`", () => {
            expect.assertions(6);

            const result = runCodegen({ projectRoot: workdir });

            // The namespace must match the sanitized form `emitApi` uses so the
            // client-side `__lunoraRef` and the server-side dispatch key agree.
            expect(result.generated.functions).toContain('import * as lunora_messages_0 from "../messages.js"');
            expect(result.generated.functions).toContain("export const LUNORA_FUNCTIONS:");
            expect(result.generated.functions).toContain('"messages:list": lunora_messages_0.list');
            expect(result.generated.functions).toContain('"messages:send": lunora_messages_0.send');
            expect(result.generated.functions).toContain("export const dispatchLunoraFunction =");
            expect(result.generated.functions).toContain("FUNCTION_NOT_FOUND");
        });

        it("writes all generated files into _generated/", () => {
            expect.assertions(9);

            runCodegen({ projectRoot: workdir });

            const generatedDirectory = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "functions.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "drizzle.global.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "drizzle.shard.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "shard.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(true);
            // The importable spec module is written alongside the JSON so the
            // worker entry can `import { openApiSpec } from "./openapi.js"`.
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(true);
        });

        it("emits openapi.json covering httpRouter routes and RPC functions", () => {
            expect.assertions(9);

            const result = runCodegen({ projectRoot: workdir });
            const document = JSON.parse(result.generated.openApi) as Record<string, unknown>;

            const paths = document.paths as Record<string, Record<string, { operationId: string }>>;

            // The typed REST routes from lunora/http.ts → real paths (with `:param`
            // rewritten to the OpenAPI `{param}` template form).
            expect(document.openapi).toBe("3.1.0");
            expect(paths["/api/messages"]?.get?.operationId).toBe("get__api_messages");
            expect(paths["/api/messages/{channelId}"]?.post).toBeDefined();

            // RPC functions → one POST operation each on /_lunora/rpc, disambiguated
            // by a #functionPath fragment; the internalMutation `purge` is excluded.
            expect(paths["/_lunora/rpc#messages:list"]?.post?.operationId).toBe("messages:list");
            expect(paths["/_lunora/rpc#messages:send"]?.post?.operationId).toBe("messages:send");
            expect(paths["/_lunora/rpc#messages:purge"]).toBeUndefined();

            // The reusable error component is referenced by operations.
            const components = document.components as {
                responses: { LunoraError: { content: Record<string, { schema: { properties: { error: { properties: { code: { enum: string[] } } } } } }> } };
            };

            expect(components.responses.LunoraError).toBeDefined();
            expect(components.responses.LunoraError.content["application/json"]?.schema.properties.error.properties.code.enum).toContain("UNAUTHORIZED");

            // Pretty-printed JSON ends with a trailing newline.
            expect(result.generated.openApi.endsWith("}\n")).toBe(true);
        });

        it('defaults to apiSpec:"openapi" — writes openapi.{json,ts} only, not openrpc.*', () => {
            expect.assertions(4);

            runCodegen({ projectRoot: workdir });

            const generatedDirectory = join(workdir, "lunora", "_generated");

            // The `.ts` module is gated on the SAME apiSpec choice as the `.json`,
            // so both regenerate together and never drift.
            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openrpc.json"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openrpc.ts"))).toBe(false);
        });

        it('apiSpec:"openrpc" writes openrpc.{json,ts} only, not openapi.*', () => {
            expect.assertions(5);

            const result = runCodegen({ apiSpec: "openrpc", projectRoot: workdir });

            const generatedDirectory = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generatedDirectory, "openrpc.json"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openrpc.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(false);

            const document = JSON.parse(result.generated.openRpc) as { methods: { name: string }[]; openrpc: string };

            expect(document.openrpc).toBe("1.3.2");
        });

        it('apiSpec:"both" writes both openapi.{json,ts} and openrpc.{json,ts}', () => {
            expect.assertions(4);

            runCodegen({ apiSpec: "both", projectRoot: workdir });

            const generatedDirectory = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openrpc.json"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openrpc.ts"))).toBe(true);
        });

        it('apiSpec:"none" writes neither spec file (json or ts)', () => {
            expect.assertions(4);

            runCodegen({ apiSpec: "none", projectRoot: workdir });

            const generatedDirectory = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openrpc.json"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openrpc.ts"))).toBe(false);
        });

        it("removes a now-stale spec file when apiSpec switches away from a format", () => {
            expect.assertions(4);

            const generatedDirectory = join(workdir, "lunora", "_generated");

            // First run writes the default openapi.* artifacts…
            runCodegen({ projectRoot: workdir });

            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(true);

            // …switching to openrpc must delete the stale openapi.* files rather
            // than leave a portable artifact documenting the old API forever.
            runCodegen({ apiSpec: "openrpc", projectRoot: workdir });

            expect(existsSync(join(generatedDirectory, "openapi.json"))).toBe(false);
            expect(existsSync(join(generatedDirectory, "openapi.ts"))).toBe(false);
        });

        it("emits openrpc.json modelling RPC functions as methods, excluding internal/stream", () => {
            expect.assertions(5);

            const result = runCodegen({ apiSpec: "openrpc", projectRoot: workdir });
            const document = JSON.parse(result.generated.openRpc) as { methods: { name: string; params: { name: string }[] }[]; openrpc: string };

            const names = document.methods.map((method) => method.name);

            expect(document.openrpc).toBe("1.3.2");
            expect(names).toContain("messages:list");
            expect(names).toContain("messages:send");
            // The internalMutation `purge` is excluded, like the OpenAPI emitter.
            expect(names).not.toContain("messages:purge");
            expect(document.methods[0]?.params[0]?.name).toBe("args");
        });

        it("threads package.json version into info.version of both OpenAPI and OpenRPC docs", () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/d1": "*" }, name: "test-app", version: "1.2.3" }), "utf8");

            const result = runCodegen({ apiSpec: "both", projectRoot: workdir });
            const openApiDoc = JSON.parse(result.generated.openApi) as { info: { version: string } };
            const openRpcDoc = JSON.parse(result.generated.openRpc) as { info: { version: string } };

            expect(openApiDoc.info.version).toBe("1.2.3");
            expect(openRpcDoc.info.version).toBe("1.2.3");
        });

        it("falls back to 0.0.0 in info.version when package.json has no version", () => {
            expect.assertions(2);

            // workdir has no package.json by default (fixture copies lunora/ only).
            const result = runCodegen({ apiSpec: "both", projectRoot: workdir });
            const openApiDoc = JSON.parse(result.generated.openApi) as { info: { version: string } };
            const openRpcDoc = JSON.parse(result.generated.openRpc) as { info: { version: string } };

            expect(openApiDoc.info.version).toBe("0.0.0");
            expect(openRpcDoc.info.version).toBe("0.0.0");
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
            expect.assertions(8);

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

            // v.id("users") inside a same-bucket table → `.references(…)`, with the
            // `(): AnySQLiteColumn` return annotation drizzle requires so a
            // self-referential FK is not circular in its own initializer
            // (LUNORA_ISSUES #2 — TS7022/TS7024 under `noImplicitAny`).
            expect(result.generated.drizzleGlobal).toContain('ownerId: text("ownerId").references((): AnySQLiteColumn => users._id).notNull()');
            expect(result.generated.drizzleGlobal).toContain('import type { AnySQLiteColumn } from "@lunora/server/drizzle";');
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
            expect.assertions(12);

            // `lint: false` keeps the emitted `LUNORA_ADVISORIES` empty so the
            // snapshot stays decoupled from advisor behaviour (a lint change
            // would otherwise churn the fixture). The advisory data path is
            // covered separately below.
            const result = runCodegen({ lint: false, projectRoot: workdir });

            const expectedApp = readFileSync(join(expectedDirectory, "app.ts"), "utf8");
            const expectedApi = readFileSync(join(expectedDirectory, "api.ts"), "utf8");
            const expectedServer = readFileSync(join(expectedDirectory, "server.ts"), "utf8");
            const expectedFunctions = readFileSync(join(expectedDirectory, "functions.ts"), "utf8");
            const expectedDataModel = readFileSync(join(expectedDirectory, "dataModel.ts"), "utf8");
            const expectedDrizzleGlobal = readFileSync(join(expectedDirectory, "drizzle.global.ts"), "utf8");
            const expectedDrizzleShard = readFileSync(join(expectedDirectory, "drizzle.shard.ts"), "utf8");
            const expectedShard = readFileSync(join(expectedDirectory, "shard.ts"), "utf8");
            const expectedOpenApi = readFileSync(join(expectedDirectory, "openapi.json"), "utf8");
            const expectedOpenApiModule = readFileSync(join(expectedDirectory, "openapi.ts"), "utf8");
            const expectedOpenRpc = readFileSync(join(expectedDirectory, "openrpc.json"), "utf8");
            const expectedOpenRpcModule = readFileSync(join(expectedDirectory, "openrpc.ts"), "utf8");

            expect(result.generated.app).toBe(expectedApp);
            expect(result.generated.api).toBe(expectedApi);
            expect(result.generated.server).toBe(expectedServer);
            expect(result.generated.functions).toBe(expectedFunctions);
            expect(result.generated.dataModel).toBe(expectedDataModel);
            expect(result.generated.drizzleGlobal).toBe(expectedDrizzleGlobal);
            expect(result.generated.drizzleShard).toBe(expectedDrizzleShard);
            expect(result.generated.shard).toBe(expectedShard);
            expect(result.generated.openApi).toBe(expectedOpenApi);
            expect(result.generated.openApiModule).toBe(expectedOpenApiModule);
            expect(result.generated.openRpc).toBe(expectedOpenRpc);
            expect(result.generated.openRpcModule).toBe(expectedOpenRpcModule);
        });

        it("emits shard.ts with a createShardDO factory wired to generated modules", () => {
            expect.assertions(8);

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.shard).toContain("export const createShardDO");
            expect(result.generated.shard).toContain('import { LUNORA_FUNCTIONS, LUNORA_LIFECYCLE_HOOKS, LUNORA_MIGRATIONS } from "./functions.js"');
            expect(result.generated.shard).toContain('import schema from "../schema.js"');
            expect(result.generated.shard).toContain("class extends ShardDOBase");
            expect(result.generated.shard).toContain("runShardMigrations");
            expect(result.generated.shard).toContain("createShardCtxDb");

            // The fixture schema declares no vector indexes, so the shard must stay
            // dependency-light and never reach for @lunora/bindings/vectors.
            expect(result.generated.shard).not.toContain("@lunora/bindings/vectors");
            expect(result.generated.shard).not.toContain("createVectorSyncHook");
        });

        it("emits app.ts with a feature-gated defineApp builder", () => {
            expect.assertions(9);

            const result = runCodegen({ projectRoot: workdir });

            // Always present: the builder, the entry factory, and the always-on methods.
            expect(result.generated.app).toContain("class AppBuilder");
            // `object`, not `Record<string, unknown>`: an `interface Env` (what
            // wrangler's worker-configuration.d.ts emits) isn't assignable to an index
            // signature, so the stricter bound forced every app into a cast.
            expect(result.generated.app).toContain("const defineApp = <Env extends object>()");
            expect(result.generated.app).toContain("public shard(");
            expect(result.generated.app).toContain("public admin(");

            // The fixture declares `.global()` tables and a `v.storage()` column, so
            // those methods (and their package imports) are emitted…
            expect(result.generated.app).toContain("public global(");
            expect(result.generated.app).toContain("public storage(");

            // …but it uses neither auth nor the scheduler, so neither method nor the
            // package import is emitted (IntelliSense lists only what's configurable).
            expect(result.generated.app).not.toContain("public auth(");
            expect(result.generated.app).not.toContain("@lunora/auth");
            expect(result.generated.app).not.toContain("@lunora/scheduler");
        });

        it("emits a long-tail .kv() pass-through (into shardExtras) when a function reads ctx.kv", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "lunora", "cache.ts"),
                `import { query, v } from "@lunora/server";
export const cached = query.input({ key: v.string() }).query(async ({ args, ctx }) => {
    return ctx.kv.get(args.key);
});
`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            // The method, the config-type alias, and the pass-through state are all emitted…
            expect(result.generated.app).toContain('public kv(factory: NonNullable<ShardConfig["kv"]>): this');
            expect(result.generated.app).toContain("type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;");
            expect(result.generated.app).toContain("private readonly shardExtras: Partial<ShardConfig> = {};");
            expect(result.generated.app).toContain("...this.shardExtras,");
            // …and an unused long-tail capability still gets no method.
            expect(result.generated.app).not.toContain("public vectors(");
        });

        it("emits a long-tail .x402() pass-through and wires the ActionCtx-only pay rail when an action reads ctx.x402", () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "lunora", "buy.ts"),
                `import { action, v } from "@lunora/server";
export const buyReport = action.input({ url: v.string() }).action(async ({ args, ctx }) => {
    const res = await ctx.x402.fetch(args.url);
    return res.text();
});
`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            // The fluent builder method + its config-type pass-through are emitted…
            // eslint-disable-next-line no-secrets/no-secrets -- asserting on a generated builder-method signature, not a credential
            expect(result.generated.app).toContain('public x402(factory: NonNullable<ShardConfig["x402"]>): this');
            // …the typed rail rides the ActionCtx…
            expect(result.generated.server).toContain("readonly x402: X402Pay;");
            // …and the value is attached only inside the action-only `if (isAction)` block.
            expect(result.generated.shard).toContain("ctx.x402 = x402;");
        });

        it("emits app.ts with the .auth() method when @lunora/auth is a declared dependency", () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "package.json"),
                `${JSON.stringify({ dependencies: { "@lunora/auth": "*", "@lunora/d1": "*" }, name: "fixture-app" }, undefined, 2)}\n`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.app).toContain("public auth(");
            expect(result.generated.app).toContain(
                'import { createAuth, createAuthAdmin, createAuthAuditReader, createDoAuthWiring, d1Executor, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth"',
            );
            expect(result.generated.app).toContain("options.authAuditReader = createAuthAuditReader(d1Executor(authD1(env) as never));");
            expect(result.generated.app).toContain("await ensureMigrated(");
        });

        it("emits the Durable-Object-backed auth branch alongside the D1 one", () => {
            expect.assertions(5);

            writeFileSync(
                join(workdir, "package.json"),
                `${JSON.stringify({ dependencies: { "@lunora/auth": "*", "@lunora/d1": "*" }, name: "fixture-app" }, undefined, 2)}\n`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });
            const app = result.generated.app ?? "";

            // `namespace` selects the DO mode — the tables live in the object because
            // `@better-auth/scim` needs transactions D1 cannot provide.
            expect(app).toContain("namespace?: Selector<Env, ShardNamespaceLike>;");
            expect(app).toContain("if (authDeclaration && authNamespace) {");

            // Identity resolution becomes a call to the object, gated on the shared
            // secret, because DO storage is unreachable from the worker.
            expect(app).toContain("const authWiring = createDoAuthWiring({");
            expect(app).toContain("options.authAuditReader = authWiring.auditReader;");

            // Both modes must be rejected together — silently doing nothing is worse.
            expect(app).toContain("pass either `d1` or `namespace`, not both");
        });

        it("emits a .buildFrameworkWorker() terminal only when a worker-composition framework adapter is a dependency", () => {
            expect.assertions(5);

            // No framework adapter → standalone only.
            const standalone = runCodegen({ projectRoot: workdir });

            expect(standalone.generated.app).not.toContain("buildFrameworkWorker");
            expect(standalone.generated.app).not.toContain("withFrameworkWorker");

            // Depending on @lunora/svelte surfaces the framework terminal + the runtime composer import.
            writeFileSync(
                join(workdir, "package.json"),
                `${JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/svelte": "*" }, name: "fixture-app" }, undefined, 2)}\n`,
                "utf8",
            );

            const framework = runCodegen({ projectRoot: workdir });

            expect(framework.generated.app).toContain("public buildFrameworkWorker(host: FrameworkHostHandler): ComposedApp");
            expect(framework.generated.app).toContain("withFrameworkWorker");
            expect(framework.generated.app).toContain("private assemble(host?: FrameworkHostHandler)");
        });

        it("collects onConnect/onDisconnect exports into the LUNORA_LIFECYCLE_HOOKS manifest and wires the shard override", () => {
            expect.assertions(6);

            writeFileSync(
                join(workdir, "lunora", "hooks.ts"),
                `import { onConnect, onDisconnect } from "@lunora/server";
export const onJoin = onConnect(async (ctx, event) => { void ctx; void event; });
export const onLeave = onDisconnect(async (ctx, event) => { void ctx; void event; });
`,
                "utf8",
            );

            const result = runCodegen({ projectRoot: workdir });

            // The hooks land in the dispatchable function table by their path…
            expect(result.generated.functions).toContain('"hooks:onJoin":');
            expect(result.generated.functions).toContain('"hooks:onLeave":');

            // …and in the connect/disconnect manifest the DO reads at runtime.
            expect(result.generated.functions).toContain('connect: ["hooks:onJoin"]');
            expect(result.generated.functions).toContain('disconnect: ["hooks:onLeave"]');

            // The generated ShardDO subclass exposes the manifest to the base via
            // the lifecycleHookPaths override.
            expect(result.generated.shard).toContain('import { LUNORA_FUNCTIONS, LUNORA_LIFECYCLE_HOOKS, LUNORA_MIGRATIONS } from "./functions.js"');
            expect(result.generated.shard).toContain("protected override lifecycleHookPaths(event:");
        });

        it("emits self-referential FKs and Id-bearing json columns that typecheck under strict TS", () => {
            expect.assertions(5);

            // LUNORA_ISSUES #2/#3, both found by running `tsc --noEmit` over a real
            // port's `_generated/`. A folder tree and a supersession chain are the
            // ordinary shapes that hit them, so they land on most non-trivial apps.
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    folders: defineTable({
        name: v.string(),
        // Self-reference: the emitted column mentions its own table binding.
        parentId: v.optional(v.id("folders")),
    }).index("by_parent", ["parentId"]),

    streamingMessages: defineTable({
        // A nested v.id() inside a union — the \`.$type<…>()\` annotation spells
        // it \`Id<"folders">\`, which the drizzle file must import.
        state: v.union(v.object({ kind: v.literal("streaming"), targetId: v.id("folders") }), v.object({ kind: v.literal("aborted"), reason: v.string() })),
    }),
});

export default schema;
`,
            );

            const result = runCodegen({ projectRoot: workdir });

            // #2: without the annotation TypeScript cannot infer through the cycle
            // (TS7022 on the binding, TS7024 on the callback) under noImplicitAny.
            expect(result.generated.drizzleShard).toContain('parentId: text("parentId").references((): AnySQLiteColumn => folders._id)');
            expect(result.generated.drizzleShard).toContain('import type { AnySQLiteColumn } from "@lunora/server/drizzle";');

            // #3: the annotation references `Id`, which used to be emitted without
            // an import → TS2304 "Cannot find name 'Id'".
            expect(result.generated.drizzleShard).toContain('Id<"folders">');
            expect(result.generated.drizzleShard).toContain('import type { Id } from "./dataModel.js";');

            // Both imports are type-only, so the `Id` edge back into dataModel.ts —
            // which is itself derived from these tables — is erased at compile time.
            expect(result.generated.drizzleShard).not.toContain("import { Id }");
        });

        it("registers a default-exported procedure as <module>.default", () => {
            expect.assertions(2);

            // LUNORA_ISSUES #27: Convex registers a module's default export as
            // `internal.<module>.default`, so ported files keep that shape. Walking
            // only named exports did not merely lose the entry — the whole module
            // was ABSENT from api.ts, so the caller's error read "Property
            // '<module>' does not exist" and pointed at a file that was correct.
            writeFileSync(
                join(workdir, "lunora", "execute.ts"),
                `import { internalAction, v } from "./_generated/server.js";

const executeTrigger = internalAction.input({ id: v.string() }).action(async () => ({ ok: true }));

export default executeTrigger;
`,
            );

            const result = runCodegen({ projectRoot: workdir });

            expect(result.generated.api).toContain("execute: {");
            expect(result.generated.api).toContain('default: FunctionReference<"action"');
        });

        it("reports an exported procedure the syntactic scan could not see", () => {
            expect.assertions(3);

            // LUNORA_ISSUES #39. Codegen registers an export only when its
            // initializer is literally a builder chain, so a factory-produced
            // procedure exists at runtime and never reaches api.ts — silently,
            // exit 0. The error then surfaced in another package as "Property
            // 'getUserSettings' does not exist", reading as a naming mistake
            // rather than a dropped function. This check is type-level, so the
            // indirection that causes the bug cannot hide it.
            writeFileSync(
                join(workdir, "lunora", "settings.ts"),
                `import type { RegisteredQuery } from "@lunora/server";

import { query } from "./_generated/server.js";

const makeGetter = (): RegisteredQuery<{}, string> => query.input({}).query(async () => "x");

export const getUserSettings = makeGetter();
`,
            );

            const result = runCodegen({ projectRoot: workdir });
            const finding = result.advisories.find((entry) => entry.name === "procedure_not_registered");

            expect(finding).toBeDefined();
            expect(finding?.detail).toContain("`getUserSettings`");
            expect(finding?.remediation).toContain("Assign the builder chain directly");
        });

        it("rejects defineTable with a non-literal field map instead of emitting a column-less table", () => {
            expect.assertions(2);

            // LUNORA_ISSUES #39, the worst of the four forms: not a missing
            // function but a table that silently loses EVERY column.
            // `defineTable(fieldsIdentifier)` is what anyone writes to share a
            // field map with an `.input()`, and it produced a `Doc_*` with only
            // `_id` and `_creationTime`. No error, no advisory.
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                `import { defineSchema, defineTable, v } from "@lunora/server";

const streamingMessagesFields = { state: v.string() };

export const schema = defineSchema({
    streamingMessages: defineTable(streamingMessagesFields),
});

export default schema;
`,
            );

            let thrown: unknown;

            try {
                runCodegen({ projectRoot: workdir });
            } catch (error: unknown) {
                thrown = error;
            }

            const message = thrown instanceof Error ? thrown.message : String(thrown);

            expect(message).toContain("codegen reads the field map syntactically");
            expect(message).toContain("Inline the fields into the defineTable(...) call");
        });

        it("names the constraint and the workaround for a nested index path", () => {
            expect.assertions(3);

            // LUNORA_ISSUES #5. `.index("by_state", ["state.kind"])` is a common
            // Convex idiom (discriminated-union column with an indexed `kind`).
            // It used to surface from the drizzle renderer as `drizzle index field
            // is not a valid JS identifier: "state.kind"`, which names neither the
            // real constraint nor what to do instead.
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    streamingMessages: defineTable({
        state: v.union(v.object({ kind: v.literal("streaming") }), v.object({ kind: v.literal("aborted") })),
    }).index("by_state", ["state.kind"]),
});

export default schema;
`,
            );

            let thrown: unknown;

            try {
                runCodegen({ projectRoot: workdir });
            } catch (error: unknown) {
                thrown = error;
            }

            const message = thrown instanceof Error ? thrown.message : String(thrown);

            expect(message).toContain('index "by_state" indexes the nested path "state.kind"');
            expect(message).toContain("Lunora indexes only top-level columns");
            // Names a concrete replacement column, and points at the mechanism
            // that keeps it in sync rather than leaving that as an exercise.
            expect(message).toContain("`stateKind`");
        });

        it("fails before emit when a schema feature's package is not declared", () => {
            expect.assertions(4);

            // LUNORA_ISSUES #9: adding one `.global()` table to a project without
            // @lunora/d1 left codegen succeeding and `tsc` failing with
            // `Cannot find module '@lunora/d1'` inside generated code — far from
            // the `.global()` that caused it. The fixture `users` table is
            // already `.global()`, so a manifest is all this needs.
            const manifest = join(workdir, "package.json");

            writeFileSync(manifest, JSON.stringify({ dependencies: { "@lunora/server": "*" }, name: "app", version: "0.0.0" }));

            let thrown: unknown;

            try {
                runCodegen({ projectRoot: workdir });
            } catch (error: unknown) {
                thrown = error;
            }

            const message = thrown instanceof Error ? thrown.message : String(thrown);

            expect(message).toContain("@lunora/d1");
            expect(message).toContain("pnpm add @lunora/d1");
            // Nothing was emitted, so the failure cannot be mistaken for a
            // type error in output the user did not write.
            expect(existsSync(join(workdir, "lunora", "_generated", "app.ts"))).toBe(false);

            // Declaring it clears the gate.
            writeFileSync(manifest, JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/server": "*" }, name: "app", version: "0.0.0" }));

            expect(() => runCodegen({ projectRoot: workdir })).not.toThrow();
        });

        it("skips the required-package gate when no manifest can be read", () => {
            expect.assertions(1);

            // The fixture has a `.global()` table and no package.json. An absent
            // manifest is "cannot tell", not "declares nothing" — otherwise every
            // manifest-less project (fixtures, embedded schemas, direct runCodegen
            // callers) would be told every add-on is missing.
            expect(() => runCodegen({ projectRoot: workdir })).not.toThrow();
        });

        it("writes nothing when discovery fails, instead of emitting an empty api", () => {
            expect.assertions(5);

            // LUNORA_ISSUES #13, the costliest defect the first large port hit.
            // A failing codegen that still wrote `api.ts` as an empty shell turned
            // one invalid cron into ~600 "Property does not exist on
            // InternalApiTypes" errors spread across every module — each pointing
            // at a caller, none at the cron. Every write happens in one block
            // after all discovery, so a discovery throw must leave the tree alone;
            // this locks that ordering in.
            const badCron = `import { cronJobs } from "@lunora/scheduler";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Valid in Convex, where { hours: 24 } is the ordinary "once a day" idiom.
crons.interval("purgeDaily", { hours: 24 }, internal.messages.purge, {});

export default crons;
`;

            // Cold: no prior output, so nothing may appear.
            const outputDirectory = join(workdir, "lunora", "_generated");

            writeFileSync(join(workdir, "lunora", "crons.ts"), badCron);

            expect(() => runCodegen({ projectRoot: workdir })).toThrow(/interval\.hours is capped at 23/u);
            expect(existsSync(join(outputDirectory, "api.ts"))).toBe(false);

            // Warm: a previous good run's output must survive the failure intact,
            // so the build breaks at the cron rather than at 600 call sites.
            rmSync(join(workdir, "lunora", "crons.ts"));
            runCodegen({ projectRoot: workdir });

            const goodApi = readFileSync(join(outputDirectory, "api.ts"), "utf8");

            expect(goodApi).toContain("purge: FunctionReference<");

            writeFileSync(join(workdir, "lunora", "crons.ts"), badCron);

            expect(() => runCodegen({ projectRoot: workdir })).toThrow(/interval\.hours is capped at 23/u);
            // Deliberately re-read rather than trusting the throw: the failure mode
            // being guarded is a write that happened anyway.
            expect(readFileSync(join(outputDirectory, "api.ts"), "utf8")).toBe(goodApi);
        });

        it("throws when schema.ts is missing", () => {
            expect.assertions(1);

            const empty = mkdtempSync(join(tmpdir(), "lunora-empty-"));

            try {
                expect(() => runCodegen({ projectRoot: empty })).toThrow(SCHEMA_NOT_FOUND_RE);
            } finally {
                rmSync(empty, { force: true, recursive: true });
            }
        });
    });

    describe("project reuse", () => {
        const lunoraDirectory = (): string => join(workdir, "lunora");

        it("produces output identical to a fresh Project when the shared Project is reused unchanged", () => {
            expect.assertions(7);

            const reference = runCodegen({ lint: false, projectRoot: workdir });

            // A second run over the same files through one shared, refreshed Project
            // must emit byte-identical content — reuse must never drift from the
            // fresh-Project baseline the first run captured.
            const project = createCodegenProject(lunoraDirectory());

            refreshCodegenProject(project, lunoraDirectory());

            const reused = runCodegen({ lint: false, project, projectRoot: workdir });

            expect(reused.generated.api).toBe(reference.generated.api);
            expect(reused.generated.server).toBe(reference.generated.server);
            expect(reused.generated.functions).toBe(reference.generated.functions);
            expect(reused.generated.dataModel).toBe(reference.generated.dataModel);
            expect(reused.generated.shard).toBe(reference.generated.shard);
            expect(reused.generated.openApi).toBe(reference.generated.openApi);

            // Re-running the SAME shared Project a third time (refreshed again, no
            // disk change) stays stable too.
            refreshCodegenProject(project, lunoraDirectory());

            const reusedAgain = runCodegen({ lint: false, project, projectRoot: workdir });

            expect(reusedAgain.generated.functions).toBe(reference.generated.functions);
        });

        it("reflects an edit to a function file on disk after refreshing the shared Project", () => {
            expect.assertions(4);

            const project = createCodegenProject(lunoraDirectory());

            refreshCodegenProject(project, lunoraDirectory());

            const before = runCodegen({ lint: false, project, projectRoot: workdir });

            expect(before.generated.api).toContain("send:");
            expect(before.generated.api).not.toContain("publish:");

            // Rename the `send` mutation to `publish` on disk, then refresh the
            // SHARED Project (what the plugin does) and re-run.
            const messagesPath = join(lunoraDirectory(), "messages.ts");
            const edited = readFileSync(messagesPath, "utf8").replace("export const send = mutation(", "export const publish = mutation(");

            writeFileSync(messagesPath, edited, "utf8");
            refreshCodegenProject(project, lunoraDirectory());

            const after = runCodegen({ lint: false, project, projectRoot: workdir });

            expect(after.generated.api).toContain("publish:");
            expect(after.generated.api).not.toContain("send:");
        });

        it("reflects an added file and drops a deleted one after refreshing the shared Project", () => {
            expect.assertions(4);

            const project = createCodegenProject(lunoraDirectory());

            refreshCodegenProject(project, lunoraDirectory());

            const before = runCodegen({ lint: false, project, projectRoot: workdir });

            expect(before.generated.api).toContain("messages:");
            expect(before.generated.functions).not.toContain("notifications:ping");

            // Add a brand-new function file and delete the existing one, then
            // refresh the shared Project and re-run.
            writeFileSync(
                join(lunoraDirectory(), "notifications.ts"),
                `import { query, v } from "@lunora/server";
export const ping = query({ args: { id: v.string() }, handler: async (_context, args) => ({ id: args.id }) });
`,
                "utf8",
            );
            rmSync(join(lunoraDirectory(), "messages.ts"), { force: true });
            refreshCodegenProject(project, lunoraDirectory());

            const after = runCodegen({ lint: false, project, projectRoot: workdir });

            // The new function is discovered…
            expect(after.generated.functions).toContain('"notifications:ping"');
            // …and the deleted file's functions are gone (stale-deleted-file guard).
            expect(after.generated.api).not.toContain("send:");
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

            const output = emitApi({ functions: [makeFunction({ returnType: 'Doc<"posts">[]' })] });

            expect(output).toContain('import type { Doc } from "./dataModel.js";');
            expect(output).not.toContain("import type { Id }");
            expect(output).not.toContain("import type { Doc, Id }");
        });

        it("imports both Doc and Id when both are referenced", () => {
            expect.assertions(1);

            const output = emitApi({ functions: [makeFunction({ args: { id: { kind: "id", tableName: "posts" } }, returnType: 'Doc<"posts">' })] });

            expect(output).toContain('import type { Doc, Id } from "./dataModel.js";');
        });

        it("imports only Id when no Doc is referenced", () => {
            expect.assertions(2);

            const output = emitApi({ functions: [makeFunction({ args: { id: { kind: "id", tableName: "posts" } }, returnType: "{ ok: boolean }" })] });

            expect(output).toContain('import type { Id } from "./dataModel.js";');
            expect(output).not.toContain("Doc");
        });

        it("omits the dataModel import when neither is referenced", () => {
            expect.assertions(1);

            const output = emitApi({ functions: [makeFunction({ returnType: "{ ok: boolean }" })] });

            expect(output).not.toContain("./dataModel.js");
        });
    });

    describe("emitVectors", () => {
        it("emits a sorted LUNORA_VECTOR_INDEXES registry from the schema's vector indexes", () => {
            expect.assertions(4);

            const output = emitVectors([
                { dimensions: 1024, field: "body", metadata: ["title"], metric: "cosine", name: "by_body", table: "docs" },
                { dimensions: 768, metric: "euclidean", name: "abstracts", table: "papers" },
            ]);

            // eslint-disable-next-line no-secrets/no-secrets -- generated type annotation, not a secret
            expect(output).toContain("export const LUNORA_VECTOR_INDEXES: ReadonlyArray<LunoraVectorIndex> = [");
            // Sorted by name: `abstracts` precedes `by_body`.
            expect(output.indexOf('name: "abstracts"')).toBeLessThan(output.indexOf('name: "by_body"'));
            // Shape A entry carries field + metadata; the metric/dimensions ride along.
            expect(output).toContain('{ name: "by_body", table: "docs", field: "body", dimensions: 1024, metric: "cosine", metadata: ["title"] },');
            // Shape B entry (no source field) omits the `field` key entirely.
            expect(output).toContain('{ name: "abstracts", table: "papers", dimensions: 768, metric: "euclidean" },');
        });

        it("emits an empty registry when the schema declares no vector indexes", () => {
            expect.assertions(2);

            const output = emitVectors([]);

            // eslint-disable-next-line no-secrets/no-secrets -- generated type annotation, not a secret
            expect(output).toContain("export const LUNORA_VECTOR_INDEXES: ReadonlyArray<LunoraVectorIndex> = [];");
            expect(output).toContain("export interface LunoraVectorIndex");
        });
    });

    describe("emitShard — storage rules", () => {
        it("emits the discovered storage rules into the storageRulesMetadata() override", () => {
            expect.assertions(3);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };
            const output = emitShard({
                schema,
                storageRules: {
                    rules: [{ bucket: "avatars", file: "avatars", on: "read", prefix: "user/", procedure: "upload" }],
                },
            });

            expect(output).toContain("protected override storageRulesMetadata(): StorageRulesResult {");
            expect(output).toContain('"bucket": "avatars"');
            expect(output).toContain('"prefix": "user/"');
        });

        it("emits an empty storage-rules metadata when none are declared", () => {
            expect.assertions(1);

            const output = emitShard({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).toContain("const LUNORA_STORAGE_RULES: StorageRulesResult = {");
        });
    });

    describe("emitShard — studio features", () => {
        it("emits the passed feature flags into the studioFeatures() override", () => {
            expect.assertions(3);

            const output = emitShard({
                schema: { tables: [], vectorIndexes: [] },
                studioFeatures: {
                    analytics: false,
                    auth: false,
                    containers: false,
                    flags: false,
                    kv: false,
                    mail: false,
                    notifications: false,
                    payments: true,
                    queues: false,
                    scheduler: false,
                    storage: true,
                    vectors: false,
                    workflows: false,
                },
            });

            expect(output).toContain("protected override studioFeatures(): StudioFeaturesResult {");
            expect(output).toContain('"payments": true');
            expect(output).toContain('"storage": true');
        });

        it("defaults every feature flag off when none are passed", () => {
            expect.assertions(2);

            const output = emitShard({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).toContain("const LUNORA_STUDIO_FEATURES: StudioFeaturesResult = {");
            expect(output).not.toContain('"payments": true');
        });
    });

    describe("emitShard — feature flags", () => {
        it("emits no flag overrides when the app wires no flags", () => {
            expect.assertions(3);

            const output = emitShard({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).not.toContain("LUNORA_FLAG_KEYS");
            expect(output).not.toContain("evaluateFlags");
            // eslint-disable-next-line no-secrets/no-secrets -- the generated override's method name asserted absent, not a secret
            expect(output).not.toContain("runFlagSubscriptionRead");
        });

        it("emits LUNORA_FLAG_KEYS plus the evaluateFlags + reactive read overrides when flags are wired", () => {
            expect.assertions(8);

            const output = emitShard({
                flagKeys: [
                    { key: "dark-mode", type: "boolean" },
                    { key: "page-size", type: "number" },
                ],
                hasFlags: true,
                schema: { tables: [], vectorIndexes: [] },
            });

            expect(output).toContain("const LUNORA_FLAG_KEYS: ReadonlyArray<{ key: string; type: ");
            expect(output).toContain('"key": "dark-mode"');
            expect(output).toContain("protected override async evaluateFlags(context?: Record<string, unknown>): Promise<FlagsResult> {");
            expect(output).toContain("protected override runFlagSubscriptionRead(");
            expect(output).toContain("FlagsResult");
            // The per-type chain keeps the typed details.* calls sound.
            expect(output).toContain("await flags.details.boolean(entry.key, false, evalContext)");
            // Security: the public reactive channel must (a) serve only statically
            // discovered flag keys, so a subscriber can't probe arbitrary/internal
            // flags, and (b) never honor client-supplied targeting context, so a
            // subscriber can't spoof attributes to unlock a gated flag.
            expect(output).toContain("!LUNORA_FLAG_KEYS.some((entry) => entry.key === key)");
            // Robustness: identify is wrapped in a thunk so a throwing identify fails open.
            expect(output).toContain("targetingKey: () => flagsConfig.identify?.(");
        });
    });

    describe("emitShard — workflows metadata", () => {
        it("emits the declared workflows into the workflowsMetadata() override", () => {
            expect.assertions(4);

            const output = emitShard({
                schema: { tables: [], vectorIndexes: [] },
                workflows: [
                    {
                        bindingName: "WORKFLOW_ORDER_PIPELINE",
                        className: "OrderPipelineWorkflow",
                        exportName: "orderPipeline",
                        name: "order-pipeline",
                        steps: [],
                    },
                ],
            });

            expect(output).toContain("protected override workflowsMetadata(): WorkflowsResult {");
            expect(output).toContain("const LUNORA_WORKFLOWS_INFO: WorkflowsResult = {");
            expect(output).toContain('"binding": "WORKFLOW_ORDER_PIPELINE"');
            expect(output).toContain('"name": "order-pipeline"');
        });

        it("omits the workflows metadata constant and override when none are declared", () => {
            expect.assertions(3);

            const output = emitShard({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).not.toContain("LUNORA_WORKFLOWS_INFO");
            expect(output).not.toContain("workflowsMetadata()");
            // Its `@lunora/do` type import is gated too, so a workflow-free shard never names it.
            expect(output).not.toContain("WorkflowsResult");
        });
    });

    describe("emitShard — global backend wiring", () => {
        const globalSchema = (globalBackend: "d1" | "hyperdrive"): SchemaIR => {
            return {
                tables: [
                    {
                        globalBackend,
                        indexes: [],
                        name: "settings",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { key: { kind: "string" } },
                        shardMode: "global",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };
        };

        it("a d1 global table wires globalDb to config.d1 and emits the d1 config field", () => {
            expect.assertions(3);

            const output = emitShard({ schema: globalSchema("d1") });

            expect(output).toContain("config.d1?.(env, { identity, userId }) ?? globalDbStub");
            expect(output).toContain("d1?: (env: Record<string, unknown>");
            expect(output).not.toContain("config.hyperdriveGlobal");
        });

        it("a hyperdrive global table wires globalDb to config.hyperdriveGlobal and emits the hyperdriveGlobal config field", () => {
            expect.assertions(3);

            const output = emitShard({ schema: globalSchema("hyperdrive") });

            expect(output).toContain("config.hyperdriveGlobal?.(env, { identity, userId }) ?? globalDbStub");
            expect(output).toContain("hyperdriveGlobal?: (env: Record<string, unknown>");
            expect(output).not.toContain("config.d1?.(env");
        });

        const settingsShape: ShapeIR = { args: {}, exportName: "allSettings", filePath: "shapes", table: "settings" };

        it("emits the global-shape poll override when a project has shapes AND a `.global()` table", () => {
            expect.assertions(3);

            const output = emitShard({ schema: globalSchema("d1"), shapes: [settingsShape] });

            // resolveShape flags a `.global()`-table shape so the base serves it via the poll path.
            expect(output).toContain('const isGlobal = (schema as unknown as SchemaLike).tables[shape.table]?.shardMode?.kind === "global"');
            // The DO reads the global membership by draining the global backend's findMany.
            expect(output).toContain("protected override async readGlobalShapeRows");
            expect(output).toContain("await globalDb.findMany(resolved.table, { cursor, where: resolved.effectiveWhere })");
        });

        it("does not emit readGlobalShapeRows when the project has shapes but no `.global()` table", () => {
            expect.assertions(1);

            const output = emitShard({
                schema: {
                    tables: [
                        { indexes: [], name: "messages", rankIndexes: [], relations: [], searchIndexes: [], shape: {}, shardMode: "root", vectorIndexes: [] },
                    ],
                    vectorIndexes: [],
                },
                shapes: [{ args: {}, exportName: "msgs", filePath: "shapes", table: "messages" }],
            });

            expect(output).not.toContain("protected override async readGlobalShapeRows");
        });
    });

    describe("emitShard — table columns", () => {
        it("prepends system fields (_id, _creationTime) to every table", () => {
            expect.assertions(4);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "posts",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { title: { kind: "string" } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"name": "_id"');
            expect(output).toContain('"pk": true');
            expect(output).toContain('"name": "_creationTime"');
            expect(output).toContain('"type": "number"');
        });

        it("emits a scalar column with its IR kind as type", () => {
            expect.assertions(2);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "posts",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { title: { kind: "string" } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"name": "title"');
            expect(output).toContain('"type": "string"');
        });

        it("unwraps v.optional(...) to the inner kind and marks optional: true", () => {
            expect.assertions(3);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "profiles",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { bio: { kind: "optional", inner: { kind: "string" } } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"name": "bio"');
            expect(output).toContain('"optional": true');
            expect(output).toContain('"type": "string"');
        });

        it("marks a defaulted column optional", () => {
            expect.assertions(2);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "posts",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { views: { kind: "number", column: { hasDefault: true, notNull: true } } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"optional": true');
            expect(output).toContain('"type": "number"');
        });

        it("records the FK target table for v.id('ref')", () => {
            expect.assertions(2);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "posts",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { author: { kind: "id", tableName: "users" } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"ref": "users"');
            expect(output).toContain('"type": "id"');
        });

        it("flags a v.storage() column with isStorage: true", () => {
            expect.assertions(1);

            const schema: SchemaIR = {
                tables: [
                    {
                        indexes: [],
                        name: "uploads",
                        rankIndexes: [],
                        relations: [],
                        searchIndexes: [],
                        shape: { avatar: { kind: "storage" } },
                        shardMode: "root",
                        vectorIndexes: [],
                    },
                ],
                vectorIndexes: [],
            };

            const output = emitShard({ schema });

            expect(output).toContain('"isStorage": true');
        });

        it("emits the LUNORA_TABLE_COLUMNS constant even for an empty schema", () => {
            expect.assertions(2);

            const output = emitShard({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).toContain("const LUNORA_TABLE_COLUMNS");
            expect(output).toContain(
                "LUNORA_TABLE_COLUMNS: Record<string, Array<{ isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }>> = {}",
            );
        });
    });

    describe("emitShard", () => {
        it("wires @lunora/bindings/vectors auto-sync when the schema declares vector indexes", () => {
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

            const output = emitShard({ schema });

            // Vectors variant: pull the adapters + the Vectorize binding type.
            expect(output).toContain('import { createContextVectors, createVectors, createVectorSyncHook } from "@lunora/bindings/vectors"');
            expect(output).toContain("VectorizeIndexLike");
            expect(output).toContain("WriteHook");

            // ctx.vectors + the auto-propagation write hook are assembled in buildCtx.
            expect(output).toContain("vectors?: (env: Record<string, unknown>) => Record<string, VectorizeIndexLike>;");
            expect(output).toContain("onWrite = createVectorSyncHook(");
            expect(output).toContain("onWrite,");
            expect(output).toContain("vectors,");
        });

        it("omits @lunora/bindings/vectors entirely when the schema declares no vectors", () => {
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

            const output = emitShard({ schema });

            expect(output).not.toContain("@lunora/bindings/vectors");
            expect(output).not.toContain("createVectorSyncHook");
            expect(output).not.toContain("onWrite");
            expect(output).toContain("export const createShardDO");
        });

        it("wires ctx.ai into the ShardDO when AI is used", () => {
            expect.assertions(8);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ schema, hasAi: true });

            // Pull the AI helper + binding type, expose the override config field,
            // and assemble ctx.ai (built from env.AI, with a throwing stub fallback).
            expect(output).toContain('import { createAi } from "@lunora/ai"');
            expect(output).toContain("AiBindingLike");
            expect(output).toContain("ai?: (env: Record<string, unknown>) => AiBindingLike;");
            expect(output).toContain("const aiStub: LunoraAi");
            expect(output).toContain(
                "createAi({ binding: aiBinding as AiBindingLike, env: env as Record<string, unknown>, metadata: { functionPath: options.functionPath, traceId: aiTrace?.traceId } })",
            );
            expect(output).toContain("ai,");
            // Correlation ids are threaded into the gateway metadata, reading the
            // dispatch trace under the same anchor guard the tracer uses.
            expect(output).toContain("const aiTrace = options.identity ? undefined : this.getCurrentTrace();");
            expect(output).toContain("traceId: aiTrace?.traceId");
        });

        it("omits @lunora/ai entirely when AI is not used", () => {
            expect.assertions(3);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ schema });

            expect(output).not.toContain("@lunora/ai");
            expect(output).not.toContain("createAi");
            expect(output).not.toContain("aiStub");
        });

        it("wires ctx.kv into the ShardDO on EVERY ctx when KV is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasKv: true, schema });

            expect(output).toContain('import { createKv } from "@lunora/bindings/kv"');
            expect(output).toContain("kv?: (env: Record<string, unknown>) => KVNamespaceLike;");
            expect(output).toContain("const kvStub: Kv");
            expect(output).toContain("createKv({ namespace: kvBinding as KVNamespaceLike })");
            expect(output).toContain("config.kv?.(env) ?? (env as Record<string, unknown>).KV");
            // KV rides the base ctx literal (every ctx) — not the `isAction` block.
            expect(output).toContain("\n                kv,");
        });

        it("wires ctx.analytics into the ShardDO on EVERY ctx (positional createAnalytics) when analytics is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasAnalytics: true, schema });

            expect(output).toContain('import { createAnalytics } from "@lunora/bindings/analytics"');
            expect(output).toContain("analytics?: (env: Record<string, unknown>) => AnalyticsEngineDatasetLike;");
            expect(output).toContain("const analyticsStub: AnalyticsClient");
            // Positional binding arg — NOT an options object.
            expect(output).toContain("createAnalytics(analyticsBinding as AnalyticsEngineDatasetLike)");
            expect(output).toContain("config.analytics?.(env) ?? (env as Record<string, unknown>).ANALYTICS");
            expect(output).toContain("\n                analytics,");
        });

        it("wires ctx.images onto the ACTION ctx ONLY (value-level) when images is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasImages: true, schema });

            expect(output).toContain('import { createImages } from "@lunora/bindings/images"');
            expect(output).toContain("images?: (env: Record<string, unknown>) => ImagesBindingLike;");
            expect(output).toContain("const imagesStub: Images");
            expect(output).toContain("createImages({ binding: imagesBinding as ImagesBindingLike })");
            // Attached only inside the `isAction` block, never spliced into the base ctx literal.
            expect(output).toContain("ctx.images = images;");
            // eslint-disable-next-line no-secrets/no-secrets -- asserting on a generated ctx-builder line, not a credential
            expect(output).toContain('const isAction = LUNORA_FUNCTIONS[options.functionPath ?? ""]?.kind === "action";');
        });

        it("wires ctx.sql (Hyperdrive) onto the ACTION ctx ONLY via a REQUIRED config thunk when hyperdrive is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasHyperdrive: true, schema });

            expect(output).toContain('import type { SqlClient } from "@lunora/hyperdrive";');
            expect(output).toContain("sql?: (env: Record<string, unknown>) => SqlClient;");
            expect(output).toContain("const sqlStub: SqlClient");
            // No auto-construct: the build is config-thunk-first (createHyperdrive returns connection info, not a SqlClient).
            expect(output).toContain("const sql: SqlClient = config.sql ? config.sql(env) : sqlStub;");
            expect(output).not.toContain("createHyperdrive");
            expect(output).toContain("ctx.sql = sql;");
        });

        it("wires ctx.browser onto the ACTION ctx ONLY via a config thunk (no puppeteer import) when browser is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasBrowser: true, schema });

            expect(output).toContain('import type { Browser } from "@lunora/browser";');
            expect(output).toContain("browser?: (env: Record<string, unknown>) => Browser;");
            expect(output).toContain("const browserStub: Browser");
            expect(output).toContain("const browser: Browser = config.browser ? config.browser(env) : browserStub;");
            // The generated server stays dependency-light: never imports the optional puppeteer peer.
            expect(output).not.toContain("@cloudflare/puppeteer");
            expect(output).toContain("ctx.browser = browser;");
        });

        it("omits the new Cloudflare helpers entirely when none are used (no isAction gate, no stubs)", () => {
            expect.assertions(8);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ schema });

            expect(output).not.toContain("@lunora/bindings/kv");
            expect(output).not.toContain("@lunora/bindings/analytics");
            expect(output).not.toContain("@lunora/bindings/images");
            expect(output).not.toContain("@lunora/hyperdrive");
            expect(output).not.toContain("@lunora/browser");
            expect(output).not.toContain("isAction");
            expect(output).not.toContain("ctx.images = images;");
            expect(output).not.toContain("kvStub");
        });

        it("never attaches ctx.sql/browser/images onto the base ctx literal (ActionCtx-only at the value level)", () => {
            expect.assertions(3);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            // The base ctx object literal runs the closing `};` that ends with the
            // workflows/payments fields — slice everything BEFORE the `isAction`
            // gate so we only inspect the shared (query/mutation/action) ctx body.
            const output = emitShard({ hasBrowser: true, hasHyperdrive: true, hasImages: true, schema });
            const baseCtxBody = output.slice(0, output.indexOf("const isAction ="));

            // None of the three action-only helpers are spliced into the shared ctx
            // literal — they're attached only inside the `if (isAction)` block below.
            expect(baseCtxBody).not.toContain("\n                sql,");
            expect(baseCtxBody).not.toContain("\n                browser,");
            expect(baseCtxBody).not.toContain("\n                images,");
        });

        it("wires ctx.payments into the ShardDO when payments are used", () => {
            expect.assertions(5);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ schema, hasPayments: true });

            expect(output).toContain('import { paymentsFromContext } from "@lunora/payment"');
            expect(output).toContain("payment?: (env: Record<string, unknown>) => PaymentsFromContextOptions;");
            expect(output).toContain("const paymentStub: LunoraPayment");
            expect(output).toContain("config.payment");
            expect(output).toContain("payments,");
        });

        it("omits @lunora/payment entirely when payments are not used", () => {
            expect.assertions(3);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ schema });

            expect(output).not.toContain("@lunora/payment");
            expect(output).not.toContain("paymentsFromContext");
            expect(output).not.toContain("paymentStub");
        });

        it("adds a typed ctx.payments to the generated ActionCtx when payments are used", () => {
            expect.assertions(4);

            const withPayments = emitServer({ hasPayments: true });

            expect(withPayments).toContain('import type { LunoraPayment } from "@lunora/payment";');
            expect(withPayments).toContain("readonly payments: LunoraPayment;");

            const withoutPayments = emitServer({});

            expect(withoutPayments).not.toContain("@lunora/payment");
            expect(withoutPayments).not.toContain("readonly payments:");
        });

        it("wires ctx.x402 onto the ACTION ctx ONLY (value-level) via a lazy, Secrets-Store-backed rail when the pay rail is used", () => {
            expect.assertions(6);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            const output = emitShard({ hasX402: true, schema });

            expect(output).toContain('import { lazyX402Pay } from "@lunora/x402/pay";');
            expect(output).toContain("x402?: (env: Record<string, unknown>) => X402PayConfig;");
            expect(output).toContain("const x402Stub: X402Pay");
            // Lazy by construction — the signer/secret cost is deferred to the first fetch,
            // and the wallet key is read through the in-scope `secrets` (Secrets Store) facade.
            expect(output).toContain("lazyX402Pay(config.x402(env), { getSecret: (name: string) => secrets.get(name) })");
            // Attached only inside the `if (isAction)` block — never spliced into the shared ctx literal.
            expect(output).toContain("ctx.x402 = x402;");
            // eslint-disable-next-line no-secrets/no-secrets -- asserting on a generated ctx-builder line, not a credential
            expect(output).toContain('const isAction = LUNORA_FUNCTIONS[options.functionPath ?? ""]?.kind === "action";');
        });

        it("never attaches ctx.x402 onto the base ctx literal, and omits the pay rail entirely when unused", () => {
            expect.assertions(5);

            const schema: SchemaIR = { tables: [], vectorIndexes: [] };

            // Slice everything BEFORE the `isAction` gate to inspect only the shared
            // (query/mutation/action) ctx body: the money-spending rail must never appear there.
            const withX402 = emitShard({ hasX402: true, schema });
            const baseCtxBody = withX402.slice(0, withX402.indexOf("const isAction ="));

            expect(baseCtxBody).not.toContain("\n                x402,");

            const withoutX402 = emitShard({ schema });

            expect(withoutX402).not.toContain("@lunora/x402/pay");
            expect(withoutX402).not.toContain("lazyX402Pay");
            expect(withoutX402).not.toContain("x402Stub");
            expect(withoutX402).not.toContain("ctx.x402 = x402;");
        });

        it("adds a typed ctx.x402 to the generated ActionCtx when the pay rail is used (and not otherwise)", () => {
            expect.assertions(4);

            const withX402 = emitServer({ hasX402: true });

            expect(withX402).toContain('import type { X402Pay } from "@lunora/x402/pay";');
            expect(withX402).toContain("readonly x402: X402Pay;");

            const withoutX402 = emitServer({});

            expect(withoutX402).not.toContain("@lunora/x402/pay");
            expect(withoutX402).not.toContain("readonly x402:");
        });

        it("adds a typed ctx.ai to the generated ActionCtx when AI is used (and not otherwise)", () => {
            expect.assertions(4);

            const withAi = emitServer({ hasAi: true });

            expect(withAi).toContain('import type { LunoraAi } from "@lunora/ai";');
            expect(withAi).toContain("readonly ai: LunoraAi;");

            const withoutAi = emitServer({});

            expect(withoutAi).not.toContain("@lunora/ai");
            expect(withoutAi).not.toContain("readonly ai:");
        });

        it("emits a CloudflareBindings / Env seam with an open index signature", () => {
            expect.assertions(3);

            const server = emitServer({});

            expect(server).toContain("export interface CloudflareBindings {");
            expect(server).toContain("readonly [binding: string]: unknown;");
            expect(server).toContain("export type Env = CloudflareBindings;");
        });

        it("narrows the Env seam with discovered AI / container / workflow binding names", () => {
            expect.assertions(3);

            const server = emitServer({
                containers: [
                    {
                        bindingName: "CONTAINER_TRANSCODER",
                        className: "TranscoderContainer",
                        exportName: "transcoder",
                        image: { buildContext: ".", dockerfilePath: "Dockerfile", kind: "dockerfile" },
                    },
                ],
                hasAi: true,
                workflows: [{ bindingName: "WORKFLOW_ORDERS", className: "OrdersWorkflow", exportName: "orders", name: "orders", steps: [] }],
            });

            expect(server).toContain("readonly AI?: unknown;");
            expect(server).toContain("readonly CONTAINER_TRANSCODER?: unknown;");
            expect(server).toContain("readonly WORKFLOW_ORDERS?: unknown;");
        });

        it("wires ctx.kv onto EVERY ctx (a KV read is allowed in deterministic handlers)", () => {
            expect.assertions(4);

            const withKv = emitServer({ hasKv: true });
            const queryCtx = ctxInterface(withKv, "QueryCtx");
            const mutationCtx = ctxInterface(withKv, "MutationCtx");
            const actionCtx = ctxInterface(withKv, "ActionCtx");

            expect(queryCtx).toContain('readonly kv: import("@lunora/bindings/kv").Kv;');
            expect(mutationCtx).toContain('readonly kv: import("@lunora/bindings/kv").Kv;');
            expect(actionCtx).toContain('readonly kv: import("@lunora/bindings/kv").Kv;');
            expect(emitServer({})).not.toContain("@lunora/bindings/kv");
        });

        it("wires ctx.analytics onto EVERY ctx (write-only fire-and-forget side effect)", () => {
            expect.assertions(4);

            const withAnalytics = emitServer({ hasAnalytics: true });

            expect(ctxInterface(withAnalytics, "QueryCtx")).toContain('readonly analytics: import("@lunora/bindings/analytics").AnalyticsClient;');
            expect(ctxInterface(withAnalytics, "MutationCtx")).toContain('readonly analytics: import("@lunora/bindings/analytics").AnalyticsClient;');
            expect(ctxInterface(withAnalytics, "ActionCtx")).toContain('readonly analytics: import("@lunora/bindings/analytics").AnalyticsClient;');
            expect(emitServer({})).not.toContain("@lunora/bindings/analytics");
        });

        it("wires ctx.sql (Hyperdrive) onto ActionCtx ONLY — never query/mutation (determinism)", () => {
            expect.assertions(4);

            const withSql = emitServer({ hasHyperdrive: true });

            expect(ctxInterface(withSql, "ActionCtx")).toContain('readonly sql: import("@lunora/hyperdrive").SqlClient;');
            expect(ctxInterface(withSql, "QueryCtx")).not.toContain("readonly sql:");
            expect(ctxInterface(withSql, "MutationCtx")).not.toContain("readonly sql:");
            expect(emitServer({})).not.toContain("@lunora/hyperdrive");
        });

        it("wires ctx.browser onto ActionCtx ONLY — never query/mutation (determinism)", () => {
            expect.assertions(4);

            const withBrowser = emitServer({ hasBrowser: true });

            expect(ctxInterface(withBrowser, "ActionCtx")).toContain('readonly browser: import("@lunora/browser").Browser;');
            expect(ctxInterface(withBrowser, "QueryCtx")).not.toContain("readonly browser:");
            expect(ctxInterface(withBrowser, "MutationCtx")).not.toContain("readonly browser:");
            expect(emitServer({})).not.toContain("@lunora/browser");
        });

        it("wires ctx.images onto ActionCtx ONLY — never query/mutation (determinism)", () => {
            expect.assertions(4);

            const withImages = emitServer({ hasImages: true });

            expect(ctxInterface(withImages, "ActionCtx")).toContain('readonly images: import("@lunora/bindings/images").Images;');
            expect(ctxInterface(withImages, "QueryCtx")).not.toContain("readonly images:");
            expect(ctxInterface(withImages, "MutationCtx")).not.toContain("readonly images:");
            expect(emitServer({})).not.toContain("@lunora/bindings/images");
        });

        it("wires ctx.pipelines onto ActionCtx ONLY — never query/mutation", () => {
            expect.assertions(4);

            const withPipelines = emitServer({ hasPipelines: true });

            expect(ctxInterface(withPipelines, "ActionCtx")).toContain('readonly pipelines: import("@lunora/bindings/pipelines").PipelineClient;');
            expect(ctxInterface(withPipelines, "QueryCtx")).not.toContain("readonly pipelines:");
            expect(ctxInterface(withPipelines, "MutationCtx")).not.toContain("readonly pipelines:");
            expect(emitServer({})).not.toContain("PipelineClient");
        });

        it("wires ctx.queues producers onto Mutation + Action ctx — never query — and the runtime specs into the shard", () => {
            expect.assertions(7);

            const queues = [{ bindingName: "QUEUE_EMAIL", exportName: "emailQueue", mode: "push" as const, name: "email-queue", tuning: {} }];
            const withQueues = emitServer({ queues });

            // The typed producer lands on Mutation + Action (enqueue is a side effect), never the deterministic Query ctx.
            expect(withQueues).toContain("export interface LunoraQueues");
            expect(withQueues).toContain("readonly emailQueue: QueueProducer<QueueBodyOf<typeof lunoraQueueDefinitions.emailQueue>>;");
            expect(ctxInterface(withQueues, "MutationCtx")).toContain("readonly queues: LunoraQueues;");
            expect(ctxInterface(withQueues, "ActionCtx")).toContain("readonly queues: LunoraQueues;");
            expect(ctxInterface(withQueues, "QueryCtx")).not.toContain("readonly queues:");

            // The shard resolves producers from env via the codegen-emitted specs.
            const shard = emitShard({ queues, schema: { tables: [], vectorIndexes: [] } });

            expect(shard).toContain("createQueueContext(env, LUNORA_QUEUES)");
            expect(shard).toContain('{ binding: "QUEUE_EMAIL", exportName: "emailQueue", name: "email-queue" }');
        });

        it("emits the queues studio metadata constant + override when queues are declared, and omits both otherwise", () => {
            expect.assertions(5);

            const queues = [
                { bindingName: "QUEUE_EMAIL", exportName: "emailQueue", mode: "pull" as const, name: "email-queue", tuning: { deadLetterQueue: "email-dlq" } },
            ];
            const shard = emitShard({ queues, schema: { tables: [], vectorIndexes: [] } });

            expect(shard).toContain("const LUNORA_QUEUES_INFO: QueuesResult = {");
            expect(shard).toContain("protected override queuesMetadata(): QueuesResult {");
            expect(shard).toContain('"mode": "pull"');
            expect(shard).toContain('"deadLetterQueue": "email-dlq"');

            // A queue-free app stays byte-identical: no metadata constant/override.
            expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).not.toContain("LUNORA_QUEUES_INFO");
        });

        it("binds every table facade through the shard ctx-db (which routes `.global()` ops to D1)", () => {
            expect.assertions(9);

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

            const output = emitShard({ schema });

            // The D1 config thunk + fallback stub appear only because a `.global()` table exists.
            expect(output).toContain(
                "d1?: (env: Record<string, unknown>, request?: { identity?: Record<string, unknown>; userId?: string }) => DatabaseWriterLike | undefined;",
            );
            expect(output).toContain("const globalDbStub: DatabaseWriterLike");
            expect(output).toContain("const globalDb: DatabaseWriterLike = config.d1?.(env, { identity, userId }) ?? globalDbStub;");

            // `globalDb` is passed into the shard ctx-db so the generic
            // `ctx.db.insert("<global>", …)`/`query`/… methods route to D1 (not just
            // the property-style `ctx.db.<global>` facade).
            expect(output).toContain("\n                globalDb,");

            // Every table — shard-local AND `.global()` — binds its facade through
            // `db` (the shard ctx-db). `createShardCtxDb` routes global ops to the
            // D1 `globalDb` internally while still firing the read-dependency /
            // change-broadcast hooks that drive live subscriptions; binding a global
            // facade straight to `globalDb` would skip those.
            expect(output).toContain('facade["messages"] = bindTableFacade(db, "messages");');
            expect(output).toContain('facade["users"] = bindTableFacade(db, "users");');

            // Reverse cross-backend relations: the `runRelationFanoutRead` override
            // is emitted only when a `.global()` table exists (a reverse relation
            // needs a global parent). It builds the schema-aware ctx-db and delegates
            // to the canonical `@lunora/do` `serveRelationFanout` helper (a one-line
            // body — the guards + read/count dispatch live in that helper, not here).
            expect(output).toContain("protected override async runRelationFanoutRead(functionPath: string, args: Record<string, unknown>): Promise<unknown>");
            expect(output).toContain('serveRelationFanout, ShardDO as ShardDOBase } from "@lunora/do";');
            expect(output).toContain("return serveRelationFanout(schema as unknown as SchemaLike, db, functionPath, args);");
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

            const output = emitShard({ schema });

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

            const output = emitShard({ schema });

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
            expect(output).not.toContain("import * as lunora_");
            expect(output).not.toContain("LUNORA_FUNCTIONS");
            expect(output).toContain("export const v = vBase as unknown as");
            expect(output).toContain("export const mutation = lunoraBuilders.mutation as unknown as");
            // The facade import stays minimal (ORM types are always pulled in).
            expect(output).toContain(
                'import type { DataModel, DatabaseReaderFacade, DatabaseWriterFacade, Doc, Id as IdOfTable, OrmReader, OrmWriter, Relations, TableName } from "./dataModel.js";',
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

            const output = emitFunctions({ functions: [makeFunction("ping")] });

            // functions.ts imports the user modules, so its edge back to server.ts
            // must be type-only — otherwise the two form a runtime cycle again.
            expect(output).toContain('import type { ActionCtx, MutationCtx, QueryCtx } from "./server.js";');
            expect(output).toContain('import * as lunora_posts_0 from "../posts.js";');
        });

        it("renders the caller arg as optional only when the function takes none", () => {
            expect.assertions(2);

            const output = emitFunctions({ functions: [makeFunction("ping"), makeFunction("get", { args: { id: { kind: "id", tableName: "posts" } } })] });

            expect(output).toContain("ping: (args?: {}) => Promise<unknown>;");
            expect(output).toContain('get: (args: { id: Id<"posts"> }) => Promise<unknown>;');
        });

        it("threads a function's concrete return type through the caller", () => {
            expect.assertions(2);

            const output = emitFunctions({ functions: [makeFunction("count", { returnType: "number" })] });

            expect(output).toContain("count: (args?: {}) => Promise<number>;");
            expect(output).toContain('count: (args) => callRegistered(context, "posts:count", args),');
        });

        it("emits an empty caller (and no unused locals) when there are no functions", () => {
            expect.assertions(4);

            const output = emitFunctions({ functions: [] });

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

    describe("vector index names", () => {
        const vectorSchema: SchemaIR = {
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
            vectorIndexes: [{ dimensions: 768, field: "body", metric: "cosine", name: "docs-body", table: "docs" }],
        };

        it("narrows ctx.vectors to the declared index names", () => {
            expect.assertions(3);

            const output = emitServer({ schema: vectorSchema });

            // A typo'd index name should be a compile error, not a runtime
            // "unknown index" throw from the binding facade.
            expect(output).toContain("readonly vectors: VectorSearch<VectorIndexName>;");
            expect(output).toContain("readonly vectors: VectorSearchReader<VectorIndexName>;");
            expect(output).toContain('import type { VectorIndexName } from "./dataModel.js";');
        });

        it("leaves ctx.vectors alone when the schema declares no vector index", () => {
            expect.assertions(1);

            const output = emitServer({ schema: { tables: [], vectorIndexes: [] } });

            expect(output).not.toContain("VectorSearch<VectorIndexName>");
        });
    });

    describe("search indexes on `.global()` tables", () => {
        const globalSearchSchema: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "articles",
                    rankIndexes: [],
                    relations: [],
                    searchIndexes: [{ field: "body", filterFields: ["topic"], name: "by_body" }],
                    shape: { body: { kind: "string" }, topic: { kind: "string" } },
                    shardMode: "global",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };

        it("emits the index name so `.withSearchIndex()` is callable on a global table", () => {
            expect.assertions(2);

            const output = emitDataModel(globalSearchSchema);
            const block = /export interface SearchIndexNamesByTable \{(?<body>[^}]*)\}/u.exec(output)?.groups?.["body"];

            // `.global()` tables run the same search surface as sharded ones —
            // the D1 / Hyperdrive reader implements `.withSearchIndex()`, so the
            // name union must not collapse to `never` (which would type the call
            // as uncallable). Other unions (rank/geo/vector) still say `never`
            // for this table, so the assertion reads the search block alone.
            expect(block).toContain('articles: "by_body";');
            expect(block).not.toContain("articles: never;");
        });
    });

    describe("batteries-included sandbox", () => {
        const sandboxFixtureRoot = join(here, "fixtures", "agent-sandbox");
        let sandboxWorkdir: string;

        beforeEach(() => {
            sandboxWorkdir = mkdtempSync(join(tmpdir(), "lunora-sandbox-codegen-"));
            cpSync(join(sandboxFixtureRoot, "lunora"), join(sandboxWorkdir, "lunora"), { recursive: true });
        });

        afterEach(() => {
            rmSync(sandboxWorkdir, { force: true, recursive: true });
        });

        it("auto-registers the internal sandbox:invoke dispatcher when a sandbox tool is imported", () => {
            expect.assertions(3);

            const { functions } = runCodegen({ lint: false, projectRoot: sandboxWorkdir }).generated;

            expect(functions).toContain('import { sandboxComponent } from "@lunora/agent/component";');
            expect(functions).toContain("const lunoraSandbox = sandboxComponent();");
            expect(functions).toContain('"sandbox:invoke": lunoraSandbox.invoke as unknown as RegisteredLunoraFunction,');
        });

        it("wires ctx.browser onto the ActionCtx because browserTool drives the headless browser", () => {
            expect.assertions(1);

            const { server } = runCodegen({ lint: false, projectRoot: sandboxWorkdir }).generated;

            expect(ctxInterface(server, "ActionCtx")).toContain("browser");
        });

        it("does not register the sandbox dispatcher for a project without a sandbox tool", () => {
            expect.assertions(1);

            // The `simple` fixture imports no sandbox tool — its output must stay clean.
            const { functions } = runCodegen({ lint: false, projectRoot: workdir }).generated;

            expect(functions).not.toContain("sandbox:invoke");
        });
    });
});
