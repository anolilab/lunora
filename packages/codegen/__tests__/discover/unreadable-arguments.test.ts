/**
 * The advisory that replaced an abort.
 *
 * Codegen resolves an `.input(sharedArgs)` and a `{ ...sharedArgs }` to the
 * `const` literal behind them; a record ASSEMBLED at runtime has nothing to
 * read. Throwing on that took down two shipped paths (`lunora introspect`
 * generates `.input(<table>List.args)`, and `defineSchema({ ...authTables(o) })`
 * is the documented auth wiring), so the gap is reported instead — and the
 * report has to be precise, because a warning nobody can act on is noise.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverUnreadableArguments from "../../src/discover/unreadable-arguments";

// Self-contained, like `procedure-middleware.test.ts`: the classifier keys on
// the `__lunoraProcedure` brand, so the builder has to carry it here rather than
// come from an unresolvable `./_generated/server`.
const PREAMBLE = `
    declare const v: { number: () => unknown; string: () => unknown };

    interface QueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        input: <A>(args: A) => QueryBuilder<A>;
        query: <R>(handler: (options: { args: Args }) => R) => { kind: "query" };
    }

    declare const c: {
        query: QueryBuilder<Record<never, never>> & (<R>(config: { args?: Record<string, unknown>; handler: () => R }) => { kind: "query" });
    };
`;

let workdir: string;
let project: Project;

const findingsFor = (source: string): ReturnType<typeof discoverUnreadableArguments> => {
    const filePath = join(workdir, "lunora", "probe.ts");

    writeFileSync(filePath, `${PREAMBLE}${source}`, "utf8");
    // The pass deliberately reads only files discovery already loaded, so the
    // harness has to load this one — `runCodegen` gets that from
    // `discoverFunctions`. Without it every assertion here passes vacuously.
    project.addSourceFileAtPath(filePath);

    return discoverUnreadableArguments(project, join(workdir, "lunora"));
};

describe("discoverUnreadableArguments", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-unreadable-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports a chained `.input()` whose record cannot be read", () => {
        expect.assertions(2);

        const findings = findingsFor(`
    const buildArgs = () => ({ id: v.string() });

    export const list = c.query.input(buildArgs()).query(async () => []);
`);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", metadata: { exportName: "list" }, name: "procedure_arguments_unreadable" });
    });

    it("reports a bare-factory `args:` that cannot be read", () => {
        expect.assertions(1);

        // The bare factory is an IMPORTED identifier — `resolveCalleeKind` keys
        // on the import coming from a Lunora surface module.
        const findings = findingsFor(`
    import { query } from "@lunora/server";

    const buildArgs = () => ({ id: 1 });

    export const list = query({ args: buildArgs(), handler: async () => [] });
`);

        expect(findings.map((finding) => finding.metadata?.["exportName"])).toStrictEqual(["list"]);
    });

    it("stays quiet when the record resolves", () => {
        expect.assertions(1);

        const findings = findingsFor(`
    const sharedArgs = { id: v.string() };

    export const list = c.query.input({ ...sharedArgs, page: v.number() }).query(async () => []);
    export const get = c.query.input(sharedArgs).query(async () => []);
`);

        expect(findings).toStrictEqual([]);
    });

    it("stays quiet for a procedure that declares no arguments at all", () => {
        expect.assertions(1);

        expect(findingsFor(`export const list = c.query.query(async () => []);`)).toStrictEqual([]);
    });

    it("does not report a factory call whose whole options object is a variable", () => {
        expect.assertions(1);

        // `args` is optional in this form, so an unreadable options object does
        // not tell us a record was declared — reporting one would be a guess.
        // The shared tri-state still calls it opaque, which is what the security
        // lints need; this advisory is the narrower question.
        const findings = findingsFor(`
    declare const config: never;

    export const list = c.query(config);
`);

        expect(findings).toStrictEqual([]);
    });
});
