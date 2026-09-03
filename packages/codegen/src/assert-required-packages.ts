import { LunoraError } from "@lunora/errors";

import type { SchemaIR } from "./ir";

/** What the platform gate decided about the schema features that pull a package in. */
interface RequiredPackageOptions {
    /**
     * The target platform supports a vector store. `false` means the emitted
     * output withholds the Vectorize wiring, so the binding package it would
     * have imported is not required either.
     */
    hasVectors?: boolean;
}

/** One package the emitted `_generated/` will import, and the schema feature that pulls it in. */
interface RequiredPackage {
    /** The npm package name as the generated import spells it. */
    name: string;
    /** Why it is needed, phrased as the schema feature responsible. */
    reason: string;
}

/**
 * The add-on packages this schema's generated output will import.
 *
 * Deliberately keyed off the *schema*, not off the emitted text: the point is
 * to fail before emit, so the diagnostic names the `.global()` / `.vectorize()`
 * declaration rather than a module specifier in a file the user did not write.
 *
 * None of these are umbrella-provided — `lunorash` re-exports only the base
 * packages (server, values, runtime, do, client), so an umbrella project still
 * installs these separately.
 */
const requiredPackagesFor = (schema: SchemaIR, options: RequiredPackageOptions = {}): RequiredPackage[] => {
    const required: RequiredPackage[] = [];
    const globalTables = schema.tables.filter((table) => table.shardMode === "global");

    if (globalTables.some((table) => table.globalBackend !== "hyperdrive")) {
        required.push({
            name: "@lunora/d1",
            reason: "`.global()` tables are D1-backed, so `_generated/app.ts` imports the D1 `ctx.db` adapter",
        });
    }

    if (globalTables.some((table) => table.globalBackend === "hyperdrive")) {
        required.push({
            name: "@lunora/hyperdrive",
            reason: '`.global({ backend: "hyperdrive" })` tables route through `@lunora/hyperdrive/global`',
        });
    }

    // Gated on the platform verdict, not on the raw declaration: when the target
    // rates `vectorStore` as `unsupported` the shard emitter withholds the
    // `@lunora/bindings/vectors` import entirely, so demanding the package would
    // hard-fail the build over an import the generated code does not contain —
    // for a binding the host does not have, after the gate has already reported
    // the feature unsupported.
    if (schema.vectorIndexes.length > 0 && options.hasVectors !== false) {
        required.push({
            name: "@lunora/bindings",
            reason: "`.vectorize()` indexes make `_generated/shard.ts` import `@lunora/bindings/vectors`",
        });
    }

    return required;
};

/**
 * Fail codegen when the schema needs an add-on the project has not installed.
 *
 * Without this, codegen **succeeds** and only a later `tsc` fails, with
 * `Cannot find module '@lunora/d1'` reported inside `_generated/app.ts` — a
 * file the user did not write, several steps from the `.global()` that caused
 * it. Adding one `.global()` table to a project with no prior global tables is
 * enough to trigger it.
 *
 * Throws listing every missing package at once, so a project adding both
 * `.global()` and `.vectorize()` learns about both in one run.
 *
 * `dependencies` is `undefined` when no manifest could be read. That is "cannot
 * tell", not "declares nothing" — a project without a root `package.json` (the
 * codegen fixtures, an embedded schema, a tool driving `runCodegen` directly)
 * must not be told every add-on is missing. The check simply does not run.
 */
const assertRequiredPackages = (schema: SchemaIR, dependencies: ReadonlySet<string> | undefined, options: RequiredPackageOptions = {}): void => {
    if (dependencies === undefined) {
        return;
    }

    const missing = requiredPackagesFor(schema, options).filter((entry) => !dependencies.has(entry.name));

    if (missing.length === 0) {
        return;
    }

    const detail = missing.map((entry) => `  - ${entry.name} — ${entry.reason}`).join("\n");

    // No `pnpm add …` line: `@lunora/codegen` has no package-manager knowledge
    // (that lives in `@lunora/cli`, a package downstream of this one), and a
    // hardcoded pnpm command is wrong for the other three managers' projects.
    // The package names above are already copy-pastable into whichever `add`
    // command the project actually uses.
    throw new LunoraError(
        "INTERNAL",
        `@lunora/codegen: this schema's generated code imports packages the project does not declare:\n${detail}\n\nInstall them with your package manager, then re-run codegen.`,
    );
};

export default assertRequiredPackages;
export { requiredPackagesFor };
export type { RequiredPackage, RequiredPackageOptions };
