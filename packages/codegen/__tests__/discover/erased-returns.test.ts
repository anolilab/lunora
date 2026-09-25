/**
 * The advisory for the other silent downgrade.
 *
 * `procedure_arguments_unreadable` reports an argument record codegen could not
 * read. This is its output-side twin: a return type codegen could render as
 * neither a name nor a structure becomes `unknown`, which is sound, invisible,
 * and indistinguishable at the call site from a procedure that returns nothing
 * useful. An app whose outputs erased en masse saw ~700 type errors in consumer
 * code while `lunora codegen` exited 0 and no advisory fired (issue #810).
 *
 * Driven through `runCodegen` rather than against the discoverer, because the
 * erasure is recorded deep inside the type-render path and drained at the end of
 * a run — a test that calls the discoverer directly would pass over a buffer
 * nothing ever fills.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../../src/index";

const SCHEMA = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({ users: defineTable({ name: v.string() }) });
`;

/**
 * A self-referential local interface: reachable nowhere from `_generated/` (so it
 * must be expanded) and not reproducible structurally (so the expansion
 * declines). That combination is what erases a return type to `unknown`.
 */
const RECURSIVE = `
    import { query } from "@lunora/server";

    interface Tree { value: string; child: Tree }

    declare const tree: Tree;

    export const getTree = query({ args: {}, handler: async () => tree });
`;

/**
 * The same erasure through the OTHER render path: a DECLARED output whose
 * Standard Schema infers the unreproducible type. `resolve-standard-schema-type`
 * has its own fallback, so a report wired only into the handler-return path would
 * stay silent for every `.output(v.from(…))` — which is the spelling #810 was
 * filed against.
 */
const RECURSIVE_OUTPUT = `
    import { query, v } from "@lunora/server";

    interface Tree { value: string; child: Tree }

    declare const treeSchema: { readonly "~standard": { readonly version: 1; readonly vendor: "probe"; readonly types?: { input: Tree; output: Tree } | undefined } };

    export const getDeclaredTree = query
        .input({})
        .output(v.from(treeSchema))
        .query(async () => null as never);
`;

/**
 * One unreproducible schema declared once and shared by two procedures' outputs.
 * The `v.from` node lives in the shared `const`, so a record anchored there named
 * `sharedTree` and merged both procedures into one finding.
 */
const SHARED_OUTPUT = `
    import { query, v } from "@lunora/server";

    interface Tree { value: string; child: Tree }

    declare const treeSchema: { readonly "~standard": { readonly version: 1; readonly vendor: "probe"; readonly types?: { input: Tree; output: Tree } | undefined } };

    const sharedTree = v.from(treeSchema);

    export const firstTree = query.input({}).output(sharedTree).query(async () => null as never);

    export const secondTree = query.input({}).output(sharedTree).query(async () => null as never);
`;

/**
 * The same unreproducible schema as an ARGUMENT. `v.from(…)` resolves through one
 * resolver wherever it appears, but an erased input is not a return type and was
 * reported as one.
 */
const RECURSIVE_INPUT = `
    import { query, v } from "@lunora/server";

    interface Tree { value: string; child: Tree }

    declare const treeSchema: { readonly "~standard": { readonly version: 1; readonly vendor: "probe"; readonly types?: { input: Tree; output: Tree } | undefined } };

    export const takesTree = query
        .input({ tree: v.from(treeSchema) })
        .query(async () => "ok");
`;

/**
 * An erasing handler behind a DECLARED output. `api.ts` carries the `.output()`
 * type, never the handler's, so the handler's `Tree` erasing reaches nothing —
 * and the advisory's own remedy ("declare the shape with `.output(...)`") is
 * already applied.
 */
const RECURSIVE_BEHIND_OUTPUT = `
    import { query, v } from "@lunora/server";

    interface Tree { value: string; child: Tree }

    declare const tree: Tree;

    export const getOutlined = query
        .input({})
        .output(v.object({ value: v.string() }))
        .query(async () => tree);
`;

/** The control: a local interface the expander CAN reproduce, so nothing is lost and nothing is reported. */
const EXPANDABLE = `
    import { query } from "@lunora/server";

    interface Leaf { value: string }

    declare const leaf: Leaf;

    export const getLeaf = query({ args: {}, handler: async () => leaf });
`;

let workdir: string;

const runCodegenFor = (sources: Record<string, string>): ReturnType<typeof runCodegen> => {
    for (const [name, text] of Object.entries(sources)) {
        writeFileSync(join(workdir, "lunora", name), text, "utf8");
    }

    return runCodegen({ projectRoot: workdir });
};

const advisoriesFor = (sources: Record<string, string>): ReturnType<typeof runCodegen>["advisories"] => runCodegenFor(sources).advisories;

describe("procedure_return_type_erased", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-erased-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports a return type the expander could not reproduce, naming the export and what was lost", () => {
        expect.assertions(2);

        const findings = advisoriesFor({ "trees.ts": RECURSIVE }).filter((finding) => finding.name === "procedure_return_type_erased");

        expect(findings).toHaveLength(1);
        // The rendered text is the point of the report: "your `Tree` became
        // `unknown`" is actionable, "something became `unknown`" is not.
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "getTree", filePath: "trees", rendered: "Tree" },
        });
    }, 300_000);

    it("does not report a handler erasure a declared `.output(...)` replaces", () => {
        expect.assertions(2);

        const result = runCodegenFor({ "outlined.ts": RECURSIVE_BEHIND_OUTPUT });
        const findings = result.advisories.filter((finding) => finding.name === "procedure_return_type_erased");

        expect(findings).toHaveLength(0);
        // Guards the guard: the declared output really is what `api.ts` carries,
        // so there is no `unknown` anywhere for the advisory to be about.
        expect(result.generated.api).toContain('getOutlined: FunctionReference<"query", {}, { value: string }>');
    }, 300_000);

    it("reports a DECLARED `.output(v.from(…))` the expander could not reproduce", () => {
        expect.assertions(1);

        const findings = advisoriesFor({ "declared.ts": RECURSIVE_OUTPUT }).filter((finding) => finding.name === "procedure_return_type_erased");

        expect(findings.map((finding) => finding.metadata["exportName"])).toStrictEqual(["getDeclaredTree"]);
    }, 300_000);

    it("reports a shared `.output(schema)` once per procedure that uses it", () => {
        expect.assertions(1);

        const findings = advisoriesFor({ "shared.ts": SHARED_OUTPUT }).filter((finding) => finding.name === "procedure_return_type_erased");

        expect(findings.map((finding) => finding.metadata["exportName"])).toStrictEqual(["firstTree", "secondTree"]);
    }, 300_000);

    it("does not report a `v.from(…)` that erased in `.input(…)`", () => {
        expect.assertions(1);

        const findings = advisoriesFor({ "inputs.ts": RECURSIVE_INPUT }).filter((finding) => finding.name === "procedure_return_type_erased");

        expect(findings).toStrictEqual([]);
    }, 300_000);

    it("stays quiet when the type IS reproducible", () => {
        expect.assertions(2);

        const advisories = advisoriesFor({ "leaves.ts": EXPANDABLE });

        expect(advisories.map((finding) => finding.name)).not.toContain("procedure_return_type_erased");
        // Guards the guard: a run that discovered nothing at all would also
        // contain no erasure finding, and would prove nothing.
        expect(advisories.length).toBeGreaterThan(0);
    }, 300_000);

    it("reports each erasing procedure once, however many render passes see it", () => {
        expect.assertions(1);

        // Discovery runs more than once per codegen (the declaration surface is
        // emitted before handler types are inferred against it), so an
        // undeduplicated buffer reported every erasure two or three times.
        const findings = advisoriesFor({ "more.ts": RECURSIVE.replace("getTree", "getOther"), "trees.ts": RECURSIVE }).filter(
            (finding) => finding.name === "procedure_return_type_erased",
        );

        expect(findings.map((finding) => finding.metadata["exportName"])).toStrictEqual(["getOther", "getTree"]);
    }, 300_000);
});
