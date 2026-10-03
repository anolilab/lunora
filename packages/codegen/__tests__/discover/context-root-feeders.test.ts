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
});
