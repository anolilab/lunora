import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceFile } from "ts-morph";
import { Node, Project, SyntaxKind } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callSiteScopeOf } from "../../src/discover/attribution";
import discoverCallEdges from "../../src/discover/call-edges";
import discoverInserts from "../../src/discover/inserts";
import discoverKvKeyAccesses from "../../src/discover/kv-key-accesses";
import discoverQueries from "../../src/discover/queries";
import discoverTableWrites from "../../src/discover/table-writes";
import discoverWorkflowCalls from "../../src/discover/workflow-calls";
import { markerLine } from "../call-site-fixture";

let workdir: string;

const write = (relative: string, source: string): void => {
    const path = join(workdir, "lunora", relative);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source, "utf8");
};

/** The scope of every insert, by table. */
const insertScopes = (project: Project): Record<string, unknown> =>
    Object.fromEntries(discoverInserts(project, join(workdir, "lunora")).map((insert) => [insert.table, insert.scope]));

describe("call-site attribution", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-attribution-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("does not count a type-only reference as a call", () => {
        expect.assertions(1);

        write(
            "a.ts",
            `import { mutation } from "@lunora/server";
const helper = (ctx) => ctx.db.insert("secret", {});
const typed = (fn: typeof helper) => 1;
export const usesTypeOnly = mutation({ handler: (ctx, args: Parameters<typeof helper>[0]) => 1 });
export const viaTyped = mutation({ handler: (ctx) => typed(undefined as never) });
export const shadow = mutation({ handler: (ctx) => { const helper = () => 1; return helper(); } });
`,
        );

        // `typeof helper` (in an export, and in another helper's annotation) and a
        // shadowing local of the same name reach nothing.
        expect(insertScopes(new Project({ skipAddingFilesFromTsConfig: true }))).toStrictEqual({ secret: { callers: [], kind: "helper", name: "helper" } });
    });

    it("counts a helper handed on as a value — shorthand, argument, or property — as called", () => {
        expect.assertions(1);

        write(
            "a.ts",
            `import { mutation } from "@lunora/server";
const shorthand = (ctx) => ctx.db.insert("a", {});
const argument = (ctx) => ctx.db.insert("b", {});
const property = (ctx) => ctx.db.insert("c", {});
export const map = { shorthand };
export const run = mutation({ handler: (ctx) => ctx.runEach(argument) });
export const table = { create: property };
`,
        );

        expect(insertScopes(new Project({ skipAddingFilesFromTsConfig: true }))).toStrictEqual({
            a: { callers: ["map"], kind: "helper", name: "shorthand" },
            b: { callers: ["run"], kind: "helper", name: "argument" },
            c: { callers: ["table"], kind: "helper", name: "property" },
        });
    });

    it("marks a helper reached from module scope, a class, or a destructured declaration as untracked", () => {
        expect.assertions(1);

        write(
            "a.ts",
            `const viaRoute = (ctx) => ctx.db.insert("route", {});
const viaClass = (ctx) => ctx.db.insert("klass", {});
const viaDestructured = (ctx) => ctx.db.insert("destructured", {});
const viaMixin = (ctx) => ctx.db.insert("mixin", {});
export const internalOnly = internalQuery({ handler: (ctx) => viaRoute(ctx) });
http.route({ path: "/r", method: "POST", handler: httpAction(async (ctx) => viaRoute(ctx)) });
export class Svc { run(ctx) { return viaClass(ctx); } }
export const { run } = { run: (ctx) => viaDestructured(ctx) };
class Base extends mixin(viaMixin) {}
`,
        );

        // Callers attribution cannot follow make the caller list incomplete, so
        // a caller-folding rule (visibility) must not trust it.
        expect(insertScopes(new Project({ skipAddingFilesFromTsConfig: true }))).toStrictEqual({
            destructured: { callers: [], kind: "helper", name: "viaDestructured", untracked: true },
            klass: { callers: [], kind: "helper", name: "viaClass", untracked: true },
            // `extends mixin(viaMixin)` runs: a heritage expression is a value, not a type.
            mixin: { callers: [], kind: "helper", name: "viaMixin", untracked: true },
            route: { callers: ["internalOnly"], kind: "helper", name: "viaRoute", untracked: true },
        });
    });

    it("keeps a helper an internal export and an inline HTTP route share at full severity", () => {
        expect.assertions(1);

        write(
            "files.ts",
            `import { httpAction, httpRouter, internalQuery } from "@lunora/server";
const read = (ctx, args) => ctx.kv.get(args.key);
export const internalRead = internalQuery({ handler: (ctx, args) => read(ctx, args) });
const http = httpRouter();
http.route({ path: "/r", method: "POST", handler: httpAction(async (ctx, req) => read(ctx, await req.json())) });
export class Svc { run(ctx, args) { return read(ctx, args); } }
`,
        );

        const accesses = discoverKvKeyAccesses(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"), [
            { args: {}, exportName: "internalRead", filePath: "files", kind: "query", returnType: "unknown", visibility: "internal" },
        ]);

        // Not stamped `internal`: the route and the class reach the key too, so the lint keeps ERROR.
        expect(accesses.map((access) => access.visibility)).toStrictEqual([undefined]);
    });

    it("names the exported name of a renamed or default export, and module scope as module", () => {
        expect.assertions(1);

        write(
            "a.ts",
            `const run = async (ctx) => ctx.db.insert("renamed", {});
export { run as start };
const go = async (ctx) => ctx.db.insert("defaulted", {});
export default go;
export async function declared(ctx) { await ctx.db.insert("declared", {}); }
ctx.db.insert("loose", {});
`,
        );

        expect(insertScopes(new Project({ skipAddingFilesFromTsConfig: true }))).toStrictEqual({
            declared: { kind: "export", name: "declared" },
            defaulted: { kind: "export", name: "default" },
            loose: { kind: "module" },
            renamed: { kind: "export", name: "start" },
        });
    });

    it("attributes call edges in a helper to the exports reaching it", () => {
        expect.assertions(1);

        const source = `import { mutation } from "@lunora/server";
const notify = (ctx) => ctx.runMutation(internal.mail.send, {}); // @call
export const signup = mutation({ handler: (ctx) => notify(ctx) });
export const invite = mutation({ handler: (ctx) => notify(ctx) });
`;

        write("a.ts", source);

        expect(discoverCallEdges(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"))).toStrictEqual([
            {
                file: "a",
                kind: "call",
                line: markerLine(source, "call"),
                scope: { callers: ["invite", "signup"], kind: "helper", name: "notify" },
                target: "mail:send",
            },
        ]);
    });

    it("re-indexes a file whose source changed", () => {
        expect.assertions(2);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
        const file = project.createSourceFile("/lunora/a.ts", `const h = (ctx) => ctx.db.insert("t", {});\nexport const a = () => h(1);\n`);
        const insertOf = (source: SourceFile): Node => source.getDescendants().find((node) => node.getText() === `ctx.db.insert("t", {})`) as Node;

        expect(callSiteScopeOf(insertOf(file))).toStrictEqual({ callers: ["a"], kind: "helper", name: "h" });

        file.replaceWithText(`const h = (ctx) => ctx.db.insert("t", {});\nexport const b = () => h(1);\n`);

        expect(callSiteScopeOf(insertOf(file))).toStrictEqual({ callers: ["b"], kind: "helper", name: "h" });
    });

    it("indexes each file once however many collectors and call sites ask", () => {
        expect.assertions(2);

        const lines = [`import { mutation } from "@lunora/server";`];

        for (let index = 0; index < 40; index += 1) {
            lines.push(
                `const h${String(index)} = async (ctx, id) => { await ctx.db.patch(id, {}); await ctx.db.insert("t", {}); await ctx.db.query("t").collect(); ${index > 0 ? `return h${String(index - 1)}(ctx, id);` : ""} };`,
                `export const e${String(index)} = mutation({ handler: async (ctx, args) => h${String(index)}(ctx, args.id) });`,
            );
        }

        write("a.ts", lines.join("\n"));
        write("b.ts", lines.join("\n"));

        const project = new Project({ skipAddingFilesFromTsConfig: true });
        // The index walks a file's identifiers once; nothing else in these five
        // collectors does, so the count of identifier walks is the count of index
        // builds — two files, not two per call site per collector.
        const walks = vi.spyOn(Node.prototype, "getDescendantsOfKind");

        for (const discover of [discoverInserts, discoverQueries, discoverTableWrites, discoverWorkflowCalls, discoverCallEdges]) {
            discover(project, join(workdir, "lunora"));
        }

        expect(walks.mock.calls.filter(([kind]) => kind === SyntaxKind.Identifier)).toHaveLength(2);
        // The chain still resolves end to end: the deepest helper reaches every export.
        expect(
            discoverInserts(project, join(workdir, "lunora")).find(
                (insert) => insert.file === "a" && insert.scope.kind === "helper" && insert.scope.name === "h0",
            )?.scope,
        ).toMatchObject({
            callers: Array.from({ length: 40 }, (_, index) => `e${String(index)}`).toSorted((a, b) => a.localeCompare(b)),
        });

        walks.mockRestore();
    });
});
