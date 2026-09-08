import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverUnregisteredProcedures from "../../src/discover/unregistered-procedures";
import type { FunctionIR } from "../../src/ir";

/**
 * The terminal types of `@lunora/server`'s builder chains, declared locally so
 * the fixture RESOLVES without an install. That matters more than it looks:
 * this pass is a type-level check, and against an unresolvable
 * `@lunora/server` every type is `any` — so a fixture that cannot resolve tests
 * the fallback, never the check. Only the terminal identities are mirrored; see
 * `packages/server/src/builder/types.ts` for the real signatures.
 *
 * `.stream()` hangs off the QUERY builder, exactly as it does in the real
 * types, because that asymmetry is what the remediation has to get right.
 */
const SERVER = `
export interface RegisteredFunction<A, R, Kind extends "query" | "mutation" | "action"> {
    handler: (context: unknown, args: A) => R;
    kind: Kind;
}
export type RegisteredQuery<A, R> = RegisteredFunction<A, R, "query">;
export type RegisteredMutation<A, R> = RegisteredFunction<A, R, "mutation">;
export type RegisteredAction<A, R> = RegisteredFunction<A, R, "action">;
export interface RegisteredStream<A, R> {
    handler: (context: unknown, args: A, signal: AbortSignal) => AsyncIterable<R>;
    kind: "stream";
}
export declare const query: {
    input<A>(validators: A): {
        query<R>(handler: (options: { args: A }) => R): RegisteredQuery<A, Awaited<R>>;
        stream<R>(handler: (options: { args: A }) => AsyncIterable<R>): RegisteredStream<A, R>;
    };
};
export declare const action: {
    input<A>(validators: A): { action<R>(handler: (options: { args: A }) => R): RegisteredAction<A, Awaited<R>> };
};
`;

/** Two procedures assigned directly (registered) and three produced by a factory (dropped). */
const PROCS = `
import { action, query } from "./srv";

export const listed = query.input({}).query(async () => "x");
export const streamed = query.input({}).stream(async function* () { yield 1; });

const makeQuery = () => query.input({}).query(async () => "x");
export const viaFactoryQuery = makeQuery();

const makeAction = () => action.input({}).action(async () => 1);
export const viaFactoryAction = makeAction();

const makeStream = () => query.input({}).stream(async function* () { yield 1; });
export const viaFactoryStream = makeStream();
`;

const ir = (exportName: string, kind: FunctionIR["kind"]): FunctionIR => {
    return {
        args: {},
        exportName,
        filePath: "procs",
        kind,
        returnType: "unknown",
        visibility: "public",
    };
};

/** What discovery registers from {@link PROCS}: the two direct chains, not the factories. */
const REGISTERED: FunctionIR[] = [ir("listed", "query"), ir("streamed", "stream")];

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

/**
 * Load every fixture file into the Project. This pass deliberately only reads
 * files the discovery pass already loaded, so nothing is found unless they are
 * added first.
 */
const load = (...names: string[]): void => {
    for (const name of names) {
        project.addSourceFileAtPath(join(workdir, "lunora", name));
    }
};

const run = (functions: FunctionIR[] = REGISTERED) => discoverUnregisteredProcedures(project, join(workdir, "lunora"), functions);

describe("discoverUnregisteredProcedures", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-unregistered-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports every factory-produced procedure and nothing that was registered", () => {
        expect.assertions(2);

        write("srv.d.ts", SERVER);
        write("procs.ts", PROCS);
        load("srv.d.ts", "procs.ts");

        const dropped = run()
            .filter((finding) => finding.name === "procedure_not_registered")
            .map((finding) => finding.metadata["exportName"]);

        expect(dropped).toStrictEqual(["viaFactoryAction", "viaFactoryQuery", "viaFactoryStream"]);
        // `listed` and `streamed` are in `api.ts`; reporting them would be the
        // inverse defect.
        expect(dropped).not.toContain("listed");
    });

    it("quotes the chain each dropped procedure actually needs", () => {
        expect.assertions(3);

        write("srv.d.ts", SERVER);
        write("procs.ts", PROCS);
        load("srv.d.ts", "procs.ts");

        const remediation = (exportName: string): string | undefined => run().find((finding) => finding.metadata["exportName"] === exportName)?.remediation;

        // The remediation is meant to be pasted, and it used to hard-code
        // `query.….query(handler)` for every kind — telling an action author to
        // write a query. A stream is the case a `kind` alone cannot express:
        // `.stream()` is a terminal on the QUERY builder.
        expect(remediation("viaFactoryQuery")).toContain("query.input({ … }).query(handler)");
        expect(remediation("viaFactoryAction")).toContain("action.input({ … }).action(handler)");
        expect(remediation("viaFactoryStream")).toContain("query.input({ … }).stream(handler)");
    });

    it("says nothing about type resolution when types resolve", () => {
        expect.assertions(1);

        write("srv.d.ts", SERVER);
        write("procs.ts", PROCS);
        load("srv.d.ts", "procs.ts");

        // The guard on the availability probe. `RegisteredStream` was missing
        // from the type table, so a stream-only app — an LLM-chat backend — was
        // told to go fix a `tsconfig.json` that was fine.
        expect(run([ir("streamed", "stream")]).map((finding) => finding.name)).not.toContain("procedure_type_check_unavailable");
    });

    it("reports that it cannot type-check at all when `@lunora/server` does not resolve", () => {
        expect.assertions(2);

        // The half of #651 that made the other half expensive: with types
        // unresolvable every binding is `any`, so the check above matches
        // nothing and codegen prints exactly what it prints for a clean
        // project. A dropped procedure and a healthy one became the same
        // output.
        write(
            "blind.ts",
            `import { query } from "@lunora/server";

export const listed = query.input({}).query(async () => "x");

const makeQuery = () => query.input({}).query(async () => "x");

export const viaFactory = makeQuery();
`,
        );
        load("blind.ts");

        const names = run([{ ...ir("listed", "query"), filePath: "blind" }]).map((finding) => finding.name);

        expect(names).toContain("procedure_type_check_unavailable");
        // And it does NOT claim to have found the dropped export: on an `any`
        // the alias symbol is still the name the author typed, so matching it
        // would be a string comparison against the annotation text.
        expect(names).not.toContain("procedure_not_registered");
    });

    it("stays silent when there is no registered procedure to probe the checker against", () => {
        expect.assertions(1);

        write("srv.d.ts", SERVER);
        write("procs.ts", PROCS);
        load("srv.d.ts", "procs.ts");

        // An app with no procedures yet proves nothing either way, so the
        // availability finding needs a witness before it fires.
        expect(run([]).map((finding) => finding.name)).not.toContain("procedure_type_check_unavailable");
    });
});
