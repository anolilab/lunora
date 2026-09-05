import { LunoraError } from "@lunora/errors";

import type { SchemaIR } from "./ir";

/** One package the emitted `_generated/` will import, and the schema feature that pulls it in. */
interface RequiredPackage {
    /** The npm package name as the generated import spells it. */
    name: string;
    /** Why it is needed, phrased as the schema feature responsible. */
    reason: string;
}

/**
 * The emit signals that pull in an add-on package but that the schema alone
 * cannot answer. Everything derivable from the IR (`.global()`, `.vectorize()`)
 * is read off `schema` instead.
 */
interface RequiredPackageSignals {
    /**
     * The platform gate's `vectorStore` verdict. `false` means the emitted output
     * withholds the Vectorize wiring, so the binding package it would have
     * imported is not required either.
     */
    hasVectors?: boolean;

    /**
     * A declared cron or `ctx.scheduler` usage — the same OR the app emitter's
     * `hasScheduler` is built from. A cron is declared with `cronJobs` out of
     * `@lunora/server`, so nothing about it implies the scheduler dependency.
     */
    scheduler?: boolean;

    /**
     * A `v.storage()` column, a storage access rule, or `ctx.storage` usage — the
     * same OR the app emitter's `hasStorage` is built from. `v.storage()` lives in
     * `@lunora/values` and is an ordinary data type, so declaring one implies no
     * dependency on `@lunora/storage` at all.
     */
    storage?: boolean;
}

/**
 * The add-on packages this schema's generated output will import.
 *
 * Deliberately keyed off the *schema* plus the emit signals, not off the emitted
 * text: the point is to fail before emit, so the diagnostic names the
 * `.global()` / `v.storage()` / cron declaration rather than a module specifier
 * in a file the user did not write.
 *
 * Every entry here has to track what `emit-app.ts` actually imports. The three
 * signal-driven ones were missing for exactly that reason: they are emitted off
 * signals with no implied dependency (a `v.storage()` column, a declared cron, a
 * hyperdrive-backed global table), so codegen exited 0 and the build died with
 * `Cannot find module` INSIDE `_generated/app.ts` — the failure this check
 * exists to prevent.
 *
 * None of these are umbrella-provided — `lunorash` re-exports only the base
 * packages (server, values, runtime, do, client), so an umbrella project still
 * installs these separately.
 * @param schema the discovered schema.
 * @param signals the emit signals the schema cannot answer — see {@link RequiredPackageSignals}.
 */
const requiredPackagesFor = (schema: SchemaIR, signals: RequiredPackageSignals = {}): RequiredPackage[] => {
    const { hasVectors = true, scheduler = false, storage = false } = signals;
    const required: RequiredPackage[] = [];
    const globalTables = schema.tables.filter((table) => table.shardMode === "global");

    if (globalTables.some((table) => table.globalBackend !== "hyperdrive")) {
        required.push({
            name: "@lunora/d1",
            reason: "`.global()` tables are D1-backed, so `_generated/app.ts` imports the D1 `ctx.db` adapter",
        });
    }

    if (globalTables.some((table) => table.globalBackend === "hyperdrive")) {
        required.push(
            {
                name: "@lunora/hyperdrive",
                reason: '`.global({ backend: "hyperdrive" })` tables route through `@lunora/hyperdrive/global`',
            },
            // A separate specifier in the emitted file, so a strict node_modules
            // layout will not resolve it off `@lunora/hyperdrive`'s dependency on it.
            {
                name: "@lunora/sql-store",
                reason: '`.global({ backend: "hyperdrive" })` makes `_generated/app.ts` import the `SqlCtxDbOptions` / `SqlExec` types',
            },
        );
    }

    if (scheduler) {
        required.push({
            name: "@lunora/scheduler",
            reason: "a declared cron (or `ctx.scheduler` use) makes `_generated/app.ts` import `createScheduler`",
        });
    }

    if (storage) {
        required.push({
            name: "@lunora/storage",
            reason: "a `v.storage()` column, a storage access rule (or `ctx.storage` use) makes `_generated/app.ts` import `createStorage`",
        });
    }

    // Gated on the platform verdict, not on the raw declaration: when the target
    // rates `vectorStore` as `unsupported` the shard emitter withholds the
    // `@lunora/bindings/vectors` import entirely, so demanding the package would
    // hard-fail the build over an import the generated code does not contain —
    // for a binding the host does not have, after the gate has already reported
    // the feature unsupported.
    if (schema.vectorIndexes.length > 0 && hasVectors) {
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
 * @param schema the discovered schema.
 * @param dependencies the project's declared dependencies, or `undefined` when no manifest could be read.
 * @param signals the emit signals the schema cannot answer — see {@link RequiredPackageSignals}.
 */
const assertRequiredPackages = (schema: SchemaIR, dependencies: ReadonlySet<string> | undefined, signals: RequiredPackageSignals = {}): void => {
    if (dependencies === undefined) {
        return;
    }

    const missing = requiredPackagesFor(schema, signals).filter((entry) => !dependencies.has(entry.name));

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
export type { RequiredPackage, RequiredPackageSignals };
