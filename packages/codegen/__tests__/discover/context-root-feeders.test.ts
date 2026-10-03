import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAiRawRuns from "../../src/discover/ai-raw-runs";
import discoverAiToolSideEffects from "../../src/discover/ai-tool-side-effects";
import discoverArgumentDerivedFetches from "../../src/discover/argument-derived-fetches";
import discoverContextPropertyCalls from "../../src/discover/context-property-calls";
import { discoverFlagKeys } from "../../src/discover/flag-keys";
import discoverFlagReads from "../../src/discover/flag-reads";
import discoverFlagSecurityDefaults from "../../src/discover/flag-security-defaults";
import discoverIdentityClaimReads from "../../src/discover/identity-claim-reads";
import discoverKvKeyAccesses from "../../src/discover/kv-key-accesses";
import discoverMailRecipientAccesses from "../../src/discover/mail-recipient-accesses";
import discoverNormalizeIdAuthorization from "../../src/discover/normalize-id-authorization";
import { discoverNotifyCalls } from "../../src/discover/notify";
import discoverOwnerFieldWrites from "../../src/discover/owner-field-writes";
import discoverProcedureMiddleware from "../../src/discover/procedure-middleware";
import discoverSqlInterpolation from "../../src/discover/sql-interpolation";
import discoverStorageUploads from "../../src/discover/storage-uploads";
import discoverVectorNamespaceAccesses from "../../src/discover/vector-namespace-accesses";

let workdir: string;

const lunora = (): string => join(workdir, "lunora");

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

/** One exported bare-factory registration of `kind` whose positional handler takes `parameters` and runs `body`. */
const handler = (kind: "action" | "mutation" | "query", parameters: string, body: string): string =>
    `import { ${kind} } from "@lunora/server";\n\nexport const run = ${kind}({\n    args: {},\n    handler: async (${parameters}) => {\n        ${body}\n    },\n});\n`;

/** Discover with `discover` over a project holding ONE `lunora/run.ts` of `source`. */
const discoverIn = <Row>(source: string, discover: (project: Project, directory: string) => ReadonlyArray<Row>): ReadonlyArray<Row> => {
    writeFileSync(join(lunora(), "run.ts"), source, "utf8");

    return discover(newProject(), lunora());
};

/**
 * Every feeder that matched the literal `ctx.<surface>` reads the receiver
 * through the shared ctx resolver now: a renamed positional ctx (`c`) and a
 * destructured surface (`{ kv }`) find the same sites the `ctx` spelling does,
 * and the ctx-scoped exemption resolves the same way, so a server-side value
 * stays exempt. The keyword-`ctx` behaviour is unchanged (each feeder's own
 * suite pins it).
 */
describe("feeders resolve the ctx by symbol", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ctx-root-"));
        mkdirSync(lunora(), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe.each([
        ["renamed", "c, args", "c."],
        ["destructured", "{ kv, mail, vectors, sql, fetch, ai, auth }, args", ""],
    ])("through a %s ctx", (_label, parameters, prefix) => {
        it("finds a kv key from args and exempts one scoped by the identity", () => {
            expect.assertions(2);

            expect(discoverIn(handler("mutation", parameters, `await ${prefix}kv.get(args.key);`), discoverKvKeyAccesses)).toHaveLength(1);
            expect(
                discoverIn(handler("mutation", parameters, `await ${prefix}kv.get(\`\${${prefix}auth.userId}:\${args.key}\`);`), discoverKvKeyAccesses),
            ).toHaveLength(0);
        });

        it("finds a mail recipient from args and exempts the identity's own address", () => {
            expect.assertions(2);

            expect(
                discoverIn(handler("action", parameters, `await ${prefix}mail.send({ to: args.email, subject: "x" });`), discoverMailRecipientAccesses),
            ).toHaveLength(1);
            expect(
                discoverIn(
                    handler("action", parameters, `await ${prefix}mail.send({ to: ${prefix}auth.email, subject: args.subject });`),
                    discoverMailRecipientAccesses,
                ),
            ).toHaveLength(0);
        });

        it("finds a vector namespace from args and exempts one scoped by the identity", () => {
            expect.assertions(2);

            expect(
                discoverIn(handler("query", parameters, `return ${prefix}vectors.query(idx, { namespace: args.tenant });`), discoverVectorNamespaceAccesses),
            ).toHaveLength(1);
            expect(
                discoverIn(
                    handler("query", parameters, `return ${prefix}vectors.query(idx, { namespace: \`\${${prefix}auth.orgId}-\${args.tenant}\` });`),
                    discoverVectorNamespaceAccesses,
                ),
            ).toHaveLength(0);
        });

        it("finds an interpolated sql text", () => {
            expect.assertions(1);

            expect(
                discoverIn(handler("action", parameters, `return ${prefix}sql.query("SELECT * FROM t WHERE id = " + args.id);`), discoverSqlInterpolation),
            ).toHaveLength(1);
        });

        it("finds a fetch of an args-built url", () => {
            expect.assertions(1);

            expect(discoverIn(handler("action", parameters, `return ${prefix}fetch(args.url);`), discoverArgumentDerivedFetches)).toHaveLength(1);
        });

        it("finds a raw `ai.run` on an args-chosen model", () => {
            expect.assertions(1);

            expect(discoverIn(handler("action", parameters, `return ${prefix}ai.run(args.model, {});`), discoverAiRawRuns)).toHaveLength(1);
        });
    });

    it.each([
        ["renamed", "c, args", "c.db.insert"],
        ["destructured", "{ db }, args", "db.insert"],
    ])("finds an AI tool's db write through a %s ctx", (_label, parameters, call) => {
        expect.assertions(1);

        const source = handler(
            "action",
            parameters,
            `return generateText({ prompt: args.prompt, tools: { save: tool({ execute: async ({ text }) => ${call}("notes", { text }) }) } });`,
        );

        expect(discoverIn(source, discoverAiToolSideEffects)).toMatchObject([{ method: "generateText", sideEffect: "ctx.db.insert" }]);
    });

    it.each([
        ["renamed", "c, args", "c.notify.send"],
        ["destructured", "{ notify }, args", "notify.send"],
    ])("finds a notify send in a mutation through a %s ctx", (_label, parameters, call) => {
        expect.assertions(1);

        expect(discoverIn(handler("mutation", parameters, `await ${call}({ title: "x" });`), discoverNotifyCalls)).toMatchObject([
            { callee: "ctx.notify.send" },
        ]);
    });

    it.each([
        ["renamed", "c, args", "c.sql"],
        ["destructured", "{ sql }, args", "sql"],
    ])("finds a ctx property call through a %s ctx", (_label, parameters, receiver) => {
        expect.assertions(1);

        const calls = discoverIn(handler("query", parameters, `return ${receiver}.query("SELECT 1");`), (project, directory) =>
            discoverContextPropertyCalls(project, directory, "sql"),
        );

        expect(calls).toMatchObject([{ callee: "ctx.sql.query" }]);
    });

    it.each([
        ["renamed", "c, args", "c.flags"],
        ["destructured", "{ flags }, args", "flags"],
    ])("finds flag reads, keys and security defaults through a %s ctx", (_label, parameters, receiver) => {
        expect.assertions(3);

        const source = handler("query", parameters, `return ${receiver}.boolean("bypassAuth", true);`);

        expect(discoverIn(source, discoverFlagReads)).toMatchObject([{ callee: "ctx.flags.boolean" }]);
        expect(discoverIn(source, discoverFlagKeys)).toMatchObject([{ key: "bypassAuth", type: "boolean" }]);
        expect(discoverIn(source, discoverFlagSecurityDefaults)).toHaveLength(1);
    });

    it.each([
        ["renamed", "c, args", "c.mail"],
        ["destructured", "{ mail }, args", "mail"],
    ])("sees a mail send in procedure middleware through a %s ctx", (_label, parameters, receiver) => {
        expect.assertions(1);

        expect(
            discoverIn(handler("mutation", parameters, `await ${receiver}.send({ to: "a@b.c", subject: "x" });`), discoverProcedureMiddleware),
        ).toMatchObject([{ callsMail: true }]);
    });

    it.each([
        ["renamed", "c, args", "c.db", "c.auth"],
        ["destructured", "{ db, auth }, args", "db", "auth"],
    ])("treats an identity read through a %s ctx as an ownership check", (_label, parameters, database, identity) => {
        expect.assertions(1);

        const body = `if (!${identity}) throw new Error("anonymous");
        const id = ${database}.normalizeId("posts", args.id);
        if (id === null) throw new Error("not found");
        return ${database}.get(id);`;

        expect(discoverIn(handler("query", parameters, body), discoverNormalizeIdAuthorization)).toMatchObject([{ mentionsOwnership: true }]);
    });

    it.each([
        ["renamed", "c, args", "c.storage.avatars"],
        ["destructured", "{ storage }, args", "storage.avatars"],
    ])("finds a storage upload through a %s ctx", (_label, parameters, bucket) => {
        expect.assertions(1);

        expect(discoverIn(handler("action", parameters, `return ${bucket}.upload("k", args.body);`), discoverStorageUploads)).toMatchObject([
            { method: "upload" },
        ]);
    });

    it.each([
        ["renamed", "c, args", "c.auth.identity"],
        ["destructured", "{ auth }, args", "auth.identity"],
    ])("finds an identity claim read through a %s ctx", (_label, parameters, bag) => {
        expect.assertions(1);

        writeFileSync(
            join(lunora(), "identity.ts"),
            `import { defineIdentity, v } from "@lunora/server";\nexport const identity = defineIdentity({ userId: v.string() });\n`,
            "utf8",
        );

        expect(discoverIn(handler("query", parameters, `return ${bag}.role;`), discoverIdentityClaimReads)).toMatchObject([{ declared: false, key: "role" }]);
    });

    // The trust policy applies to the spelling `ctx` too: a local `let ctx` that
    // is reassigned holds whatever it was last given, so it scopes nothing.
    it("does not trust a reassigned local `let ctx`", () => {
        expect.assertions(2);

        const scoped = handler("mutation", "c, args", "await c.kv.get(c.auth.userId + args.key);");
        const rebound = handler("mutation", "c, args", "let ctx = c;\n        ctx = args;\n        await c.kv.get(ctx.auth.userId + args.key);");

        expect(discoverIn(scoped, discoverKvKeyAccesses)).toHaveLength(0);
        expect(discoverIn(rebound, discoverKvKeyAccesses)).toHaveLength(1);
    });

    // Discovery fails toward MATCHING: a site a feeder found by its `ctx.` (or,
    // for AI tools, `context.`) spelling is still found when it sits in a helper
    // outside any handler, where the symbol resolver has no handler to anchor
    // to. Each count is what `alpha` reports for the same fixture.
    describe("in a helper outside any handler", () => {
        const tool = (call: string): string => `return generateText({ prompt: args.prompt, tools: { save: tool({ execute: async ({ text }) => ${call} }) } });`;
        const normalizeBody = `if (!NAME.auth) throw new Error("anonymous");\nconst id = NAME.db.normalizeId("posts", args.id);\nif (id === null) throw new Error("x");\nreturn NAME.db.get(id);`;
        const cases: [string, "action" | "mutation" | "query", string, (project: Project, directory: string) => ReadonlyArray<unknown>][] = [
            ["kv", "mutation", "await NAME.kv.get(args.key);", discoverKvKeyAccesses],
            ["mail", "action", `await NAME.mail.send({ to: args.email, subject: "x" });`, discoverMailRecipientAccesses],
            ["vectors", "query", "return NAME.vectors.query(idx, { namespace: args.tenant });", discoverVectorNamespaceAccesses],
            ["sql", "action", `return NAME.sql.query("SELECT * FROM t WHERE id = " + args.id);`, discoverSqlInterpolation],
            ["fetch", "action", "return NAME.fetch(args.url);", discoverArgumentDerivedFetches],
            ["ai", "action", "return NAME.ai.run(args.model, {});", discoverAiRawRuns],
            ["aitool-db", "action", tool(`NAME.db.insert("notes", { text })`), discoverAiToolSideEffects],
            ["aitool-run", "action", tool(`NAME.runMutation("notes:save", { text })`), discoverAiToolSideEffects],
            ["aitool-fetch", "action", tool("NAME.fetch(text)"), discoverAiToolSideEffects],
            ["aitool-mail", "action", tool("NAME.mail.send({ to: text })"), discoverAiToolSideEffects],
            ["aitool-mail-chain", "action", tool("NAME.mail.with({}).send({ to: text })"), discoverAiToolSideEffects],
            ["notify", "mutation", `await NAME.notify.send({ title: "x" });`, discoverNotifyCalls],
            ["ctxprop", "query", `return NAME.sql.query("SELECT 1");`, (project, directory) => discoverContextPropertyCalls(project, directory, "sql")],
            ["flag-reads", "query", `return NAME.flags.boolean("bypassAuth", true);`, discoverFlagReads],
            ["flag-keys", "query", `return NAME.flags.boolean("bypassAuth", true);`, discoverFlagKeys],
            ["flag-defaults", "query", `return NAME.flags.boolean("bypassAuth", true);`, discoverFlagSecurityDefaults],
            ["middleware", "mutation", `await NAME.mail.send({ to: "a@b.c", subject: "x" });`, discoverProcedureMiddleware],
            ["normalize-id", "query", normalizeBody, discoverNormalizeIdAuthorization],
            ["storage", "action", `return NAME.storage.avatars.upload("k", args.body);`, discoverStorageUploads],
            ["storage-bucket", "action", `return NAME.storage.bucket("a").upload("k", args.body);`, discoverStorageUploads],
            ["identity", "query", "return NAME.auth.identity.role;", discoverIdentityClaimReads],
            [
                "owner-field",
                "mutation",
                `await NAME.db.insert("posts", { userId: args.userId });`,
                (project, directory) => discoverOwnerFieldWrites(project, directory, [], []),
            ],
        ];
        // [spelled `ctx`, spelled `context`] row counts on `alpha`.
        const ALPHA_COUNTS: Record<string, [number, number]> = {
            kv: [1, 0],
            mail: [1, 0],
            vectors: [1, 0],
            sql: [1, 0],
            fetch: [1, 0],
            ai: [1, 0],
            "aitool-db": [1, 1],
            "aitool-run": [1, 1],
            "aitool-fetch": [1, 1],
            "aitool-mail": [1, 1],
            "aitool-mail-chain": [1, 1],
            notify: [0, 0],
            ctxprop: [0, 0],
            "flag-reads": [0, 0],
            "flag-keys": [1, 0],
            "flag-defaults": [1, 0],
            middleware: [1, 1],
            "normalize-id": [0, 0],
            storage: [1, 0],
            "storage-bucket": [1, 0],
            identity: [1, 1],
            "owner-field": [1, 0],
        };

        it.each(
            cases.flatMap(([label, kind, body, discover]) =>
                (["ctx", "context"] as const).map(
                    (name, index) => [`${name}/${label}`, kind, name, body.replaceAll("NAME", name), discover, ALPHA_COUNTS[label]?.[index]] as const,
                ),
            ),
        )("finds %s as alpha did", (_label, kind, name, body, discover, expected) => {
            expect.assertions(1);

            writeFileSync(
                join(lunora(), "identity.ts"),
                `import { defineIdentity, v } from "@lunora/server";\nexport const identity = defineIdentity({ userId: v.string() });\n`,
                "utf8",
            );

            const source = `import { ${kind} } from "@lunora/server";\nconst helper = async (${name}, args) => {\n${body}\n};\nexport const run = ${kind}({ args: {}, handler: async (c, a) => helper(c, a) });\n`;

            expect(discoverIn(source, discover)).toHaveLength(expected ?? -1);
        });

        it("labels an AI tool built in a helper by the receiver as written", () => {
            expect.assertions(1);

            const source = `import type { ActionCtx } from "@lunora/server";\nexport const runAgent = (context: ActionCtx, prompt: string) =>\n    generateText({ prompt, tools: { save: tool({ execute: async ({ text }) => context.runMutation("notes:save", { text }) }) } });\n`;

            expect(discoverIn(source, discoverAiToolSideEffects)).toMatchObject([{ method: "generateText", sideEffect: "context.runMutation" }]);
        });

        it("labels an AI tool in a handler with a renamed ctx by the ctx surface", () => {
            expect.assertions(1);

            const source = handler(
                "action",
                "c, args",
                `return generateText({ prompt: args.prompt, tools: { save: tool({ execute: async ({ text }) => c.runMutation("notes:save", { text }) }) } });`,
            );

            expect(discoverIn(source, discoverAiToolSideEffects)).toMatchObject([{ method: "generateText", sideEffect: "ctx.runMutation" }]);
        });
    });
});
