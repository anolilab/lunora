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
export type LifecycleEventKind = "connect" | "disconnect" | "init" | "reactor";
export type RegisteredLifecycleHook = RegisteredFunction<Record<string, never>, void, "mutation"> & { readonly lifecycle: LifecycleEventKind };
export type RegisteredReactor = RegisteredFunction<Record<string, never>, { digest: string }, "mutation"> & { readonly lifecycle: "reactor" };
export declare const onConnect: (handler: () => Promise<void>) => RegisteredLifecycleHook;
export declare const onQueryChange: <T>(select: () => Promise<T>, handler: (context: unknown, result: T) => Promise<void>) => RegisteredReactor;
export interface RegisteredMutator { readonly __lunoraMutator: true }
export interface RegisteredShape { readonly table: string }
export interface RegisteredMigration { readonly id: string }
export interface WorkflowDefinition { readonly run: () => Promise<void> }
export interface QueueDefinition { readonly handler: () => Promise<void> }
export interface AgentDefinition { readonly instructions: string }
export interface ContainerDefinition { readonly image: string }
export declare const defineMutator: (definition: { args?: unknown; client?: unknown; server: unknown }) => RegisteredMutator;
export declare const defineShape: (definition: { table: string; where: () => unknown }) => RegisteredShape;
export declare const defineMigration: (definition: { id: string; table: string; up: (document: unknown) => unknown }) => RegisteredMigration;
export declare const defineWorkflow: (config: { run: () => Promise<void> }) => WorkflowDefinition;
export declare const defineQueue: (config: { handler: () => Promise<void> }) => QueueDefinition;
export declare const defineAgent: (config: { instructions: string; model: string }) => AgentDefinition;
export declare const defineContainer: (config: { image: string }) => ContainerDefinition;
`;

/** Two procedures assigned directly (registered) and three produced by a factory (dropped). */
const PROCS = `
import { action, onConnect, onQueryChange, query } from "./srv";

export const listed = query.input({}).query(async () => "x");
export const streamed = query.input({}).stream(async function* () { yield 1; });

const makeQuery = () => query.input({}).query(async () => "x");
export const viaFactoryQuery = makeQuery();

const makeAction = () => action.input({}).action(async () => 1);
export const viaFactoryAction = makeAction();

const makeStream = () => query.input({}).stream(async function* () { yield 1; });
export const viaFactoryStream = makeStream();

const makeHook = () => onConnect(async () => {});
export const viaFactoryHook = makeHook();

const makeReactor = () => onQueryChange(async () => 1, async () => {});
export const viaFactoryReactor = makeReactor();
`;

/**
 * The other seven registration kinds, each in both shapes: assigned directly
 * (registered) and produced by a factory (dropped in silence until now).
 */
const KIND_MODULES: ReadonlyArray<{ call: string; direct: string; factory: string; file: string; importName: string }> = [
    { call: "defineMutator({ server: async () => {} })", direct: "directMutator", factory: "viaFactoryMutator", file: "mutators", importName: "defineMutator" },
    {
        call: 'defineShape({ table: "users", where: () => ({}) })',
        direct: "directShape",
        factory: "viaFactoryShape",
        file: "shapes",
        importName: "defineShape",
    },
    {
        call: "defineWorkflow({ run: async () => {} })",
        direct: "directWorkflow",
        factory: "viaFactoryWorkflow",
        file: "workflows",
        importName: "defineWorkflow",
    },
    { call: "defineQueue({ handler: async () => {} })", direct: "directQueue", factory: "viaFactoryQueue", file: "queues", importName: "defineQueue" },
    { call: 'defineAgent({ instructions: "do", model: "m" })', direct: "directAgent", factory: "viaFactoryAgent", file: "agents", importName: "defineAgent" },
    {
        call: 'defineContainer({ image: "./Dockerfile" })',
        direct: "directContainer",
        factory: "viaFactoryContainer",
        file: "containers",
        importName: "defineContainer",
    },
];

/**
 * One module per single-file kind, each holding a directly-assigned
 * registration and a factory-produced one.
 *
 * The file names are not decoration: `discoverShapes` and friends read ONE
 * module each (`shapes.ts`, `mutators.ts`, …), so a fixture that piles them
 * into a shared file tests a shape discovery never looks at — which is exactly
 * how the first version of this change produced findings for healthy exports.
 */
const kindModule = ({ call, direct, factory, importName }: (typeof KIND_MODULES)[number]): string =>
    `import { ${importName} } from "./srv";

export const ${direct} = ${call};

const make = () => ${call};

export const ${factory} = make();
`;

/** Migrations are directory-scoped, so this one may live anywhere. */
const MIGRATIONS = `
import { defineMigration } from "./srv";

export const directMigration = defineMigration({ id: "a", table: "users", up: (document) => document });

const makeMigration = () => defineMigration({ id: "b", table: "users", up: (document) => document });

export const viaFactoryMigration = makeMigration();
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

/** The identities discovery reports for every directly-assigned export above. */
const OTHER_REGISTRATIONS = {
    // Workflows, queues, agents and containers record no file in their IR.
    byName: ["directWorkflow", "directQueue", "directAgent", "directContainer"],
    byPath: ["mutators:directMutator", "shapes:directShape", "migrations:directMigration"],
};

/** Write every single-file kind's module plus the migrations one. */
const writeOtherKinds = (write: (name: string, source: string) => void, load: (...names: string[]) => void): void => {
    const names = KIND_MODULES.map((kind) => `${kind.file}.ts`);

    for (const kind of KIND_MODULES) {
        write(`${kind.file}.ts`, kindModule(kind));
    }

    write("migrations.ts", MIGRATIONS);
    load("srv.d.ts", ...names, "migrations.ts");
};

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

const run = (functions: FunctionIR[] = REGISTERED, others: { byName?: string[]; byPath?: string[] } = {}) =>
    discoverUnregisteredProcedures(project, join(workdir, "lunora"), {
        byName: new Set(others.byName),
        byPath: new Set([...functions.map((entry) => `${entry.filePath}:${entry.exportName}`), ...(others.byPath ?? [])]),
    });

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

        expect(dropped).toStrictEqual(["viaFactoryAction", "viaFactoryHook", "viaFactoryQuery", "viaFactoryReactor", "viaFactoryStream"]);
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

    it("reports a dropped lifecycle hook and reactor, which have no caller to fail instead", () => {
        expect.assertions(4);

        write("srv.d.ts", SERVER);
        write("procs.ts", PROCS);
        load("srv.d.ts", "procs.ts");

        const finding = (exportName: string) => run().find((entry) => entry.metadata["exportName"] === exportName);

        // These were dropped in total silence, and they are the worst of the
        // family: a dropped query eventually surfaces as `Property 'x' does not
        // exist` at a call site, while a dropped `onConnect` has no caller at
        // all — the hook simply never fires, forever, with no error anywhere.
        expect(finding("viaFactoryHook")?.remediation).toContain("onConnect(handler)");
        // `onConnect`, `onDisconnect` and `onShardInit` share one type, so the
        // finding must not claim to know which was written.
        expect(finding("viaFactoryHook")?.remediation).toContain("Substitute the hook you called");
        expect(finding("viaFactoryReactor")?.remediation).toContain("onQueryChange(select, handler)");
        expect(finding("viaFactoryReactor")?.remediation).toContain("never runs");
    });

    it("reports every other registration kind dropped by a factory, and none that was registered", () => {
        expect.assertions(2);

        write("srv.d.ts", SERVER);
        writeOtherKinds(write, load);

        // #651 was reported for procedures, but it was never only procedures:
        // every `define*` discoverer walks exported declarations and skips
        // anything whose initializer is not literally its own call, so a factory
        // is dropped in silence the same way. `mutators.ts:153`,
        // `shapes.ts:146`, `workflows.ts:208`, `queues.ts:131`,
        // `agents.ts:144`, `containers.ts:281`, `migrations.ts:132`.
        const reported = run([], OTHER_REGISTRATIONS)
            .filter((finding) => finding.name === "procedure_not_registered")
            .map((finding) => finding.metadata["exportName"]);

        expect(reported).toStrictEqual([
            "viaFactoryAgent",
            "viaFactoryContainer",
            "viaFactoryMigration",
            "viaFactoryMutator",
            "viaFactoryQueue",
            "viaFactoryShape",
            "viaFactoryWorkflow",
        ]);
        // The seven healthy ones must stay quiet — a row added before the kind's
        // identity reaches `Registrations` would report every one of them.
        expect(reported.filter((name) => String(name).startsWith("direct"))).toStrictEqual([]);
    });

    it("quotes each kind's own registering call", () => {
        expect.assertions(7);

        write("srv.d.ts", SERVER);
        writeOtherKinds(write, load);

        const remediation = (exportName: string): string =>
            run([], OTHER_REGISTRATIONS).find((entry) => entry.metadata["exportName"] === exportName)?.remediation ?? "";

        expect(remediation("viaFactoryMutator")).toContain("defineMutator({ … })");
        expect(remediation("viaFactoryShape")).toContain("defineShape({ … })");
        expect(remediation("viaFactoryMigration")).toContain("defineMigration({ … })");
        expect(remediation("viaFactoryWorkflow")).toContain("defineWorkflow({ … })");
        expect(remediation("viaFactoryQueue")).toContain("defineQueue({ … })");
        expect(remediation("viaFactoryAgent")).toContain("defineAgent({ … })");
        expect(remediation("viaFactoryContainer")).toContain("defineContainer({ … })");
    });

    it("names the conventional module when a single-file kind is registered from the wrong one", () => {
        expect.assertions(3);

        write("srv.d.ts", SERVER);
        // Directly assigned, nothing indirect about it — but `discoverShapes`
        // reads `lunora/shapes.ts` and nothing else, so it is dropped anyway.
        // Reporting the factory cause here would send the reader to inline a
        // factory that is not the problem, and they would still get nothing.
        write("elsewhere.ts", `import { defineShape } from "./srv";\n\nexport const stray = defineShape({ table: "users", where: () => ({}) });\n`);
        load("srv.d.ts", "elsewhere.ts");

        const finding = run([], OTHER_REGISTRATIONS).find((entry) => entry.metadata["exportName"] === "stray");

        expect(finding?.detail).toContain("only from `lunora/shapes.ts`");
        expect(finding?.remediation).toContain("Move it into `lunora/shapes.ts`");
        expect(finding?.remediation).not.toContain("cannot be read statically");
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
