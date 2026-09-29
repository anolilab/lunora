/**
 * Project-level validation: the config checked against the project around it —
 * container images, unchained capabilities, and classes the worker entry does not
 * export.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import join from "../path";
import type { SchemaInfo } from "../schema-info";
import { discoverSchemaInfo } from "../schema-info";
import { COMPOSED_ENTRY_DURABLE_OBJECTS, GENERATED_CLASS_MODULES, isFrameworkDurableObject } from "../worker-entry";
import { objectBindingEntries } from "./validate-bindings";
import type { CapabilityMethod, WorkerEntry, WorkerEntryLocation } from "./worker-entry-checks";
import { locateWorkerEntry, readWorkerEntry, scanAppChains } from "./worker-entry-checks";
import type { WranglerConfig, WranglerContainerEntry, WranglerValidationReport } from "./wrangler-config";
import { mergeWranglerEnvironment } from "./wrangler-environment";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";
import { validateWranglerConfig } from "./wrangler-validator";

interface WranglerProjectValidationOptions {
    /**
     * Cloudflare environment to validate against `env.<name>` in
     * wrangler.jsonc. See {@link mergeWranglerEnvironment} for which keys
     * inherit the top-level value vs must be redeclared per environment.
     * Omit to validate the top-level config only (unchanged default).
     */
    environment?: string;
    projectRoot: string;
    schemaDir?: string;
}

interface WranglerProjectValidationResult {
    problems: ReadonlyArray<string>;
    report: WranglerValidationReport;
    wranglerPath: string | undefined;
}

/**
 * The entries of a config array that TypeScript believes is an array but JSONC
 * does not guarantee. `WranglerConfig` describes a WELL-FORMED config; a
 * hand-written `"containers": {}` / `"workflows": {}` is reported by the shape
 * validator, but the FS-aware checks below run regardless and a bare `for…of`
 * over the object threw `is not iterable` out of `validateWranglerProject` —
 * a stack trace instead of the diagnostic, on every deploy/prepare/verify and
 * every `lunora dev` start.
 */
const iterableEntries = <T>(value: ReadonlyArray<T> | undefined): ReadonlyArray<T> => (Array.isArray(value) ? (value as ReadonlyArray<T>) : []);

/**
 * FS-aware existence check for local-path container images: every `./`, `../`,
 * `/`, or `Dockerfile`-bearing image must resolve to an existing file (wrangler
 * resolves it relative to the config file). Registry references are skipped.
 */
const collectContainerImageErrors = (
    containers: ReadonlyArray<WranglerContainerEntry | null | undefined>,
    configDirectory: string,
    wranglerPath: string,
): string[] => {
    const errors: string[] = [];

    for (const entry of iterableEntries(containers)) {
        const image = entry?.image;

        if (typeof image !== "string" || !(image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile"))) {
            continue;
        }

        if (!existsSync(image.startsWith("/") ? image : join(configDirectory, image))) {
            errors.push(
                `containers image "${image}" does not exist (resolved relative to ${wranglerPath}); create the Dockerfile or point image at a registry reference`,
            );
        }
    }

    return errors;
};

/**
 * Report a schema declaration whose matching `defineApp()` chain is missing.
 *
 * The generated builder already fails for these — but from the first REQUEST. So
 * `lunora codegen`, `build`, `verify`, `tsc` and the test suite all pass on a tree
 * where the app cannot answer, and it ships in that state.
 *
 * Without `.vectors()`, `ctx.vectors` is a throwing stub and `buildWorkerOptions`
 * rejects EVERY request, `/_lunora/health` included. Without `.global()` (or
 * `.hyperdriveGlobal()`), the shard gets no global writer, so every read or write
 * of a global table throws `INTERNAL` ("requires a globalDb writer") — and nothing
 * else says a word, because the wrangler check next to this one proves the `DB`
 * BINDING exists, which is the half a project usually gets right.
 *
 * Both requirements are static: the schema states them, and whether the app chains
 * the matching call is readable from the source. Same relationship the
 * unexported-class check validates, which is why it lives here rather than in the
 * runtime.
 *
 * Blocking — and not only at deploy: `@lunora/vite`'s wrangler-validator plugin
 * throws on any reported problem at `configResolved`, so this also refuses to
 * start `lunora dev`. Vector indexes are rare, but `.global()` tables are the
 * common case, and unlike the `DB` binding validated next to it, Lunora cannot
 * write the `.global(...)` chain into the user's `src/server.ts` for them. That
 * is the intended trade — the alternative is a dev server whose every global read
 * throws INTERNAL — but it is why every give-up route below reports nothing.
 *
 * It fails open both ways — see {@link scanAppChains}, which reads the
 * PROJECT rather than the worker entry. Keying "does this project compose an app"
 * on the entry is what silently disabled the check for the two commonest Vite-first
 * layouts: `main: "virtual:lunora/worker"` names no file at all, and a generated
 * `src/worker.ts` only re-exports the app composed in `src/server.ts`.
 */
const collectUnchainedCapabilityErrors = (schema: SchemaInfo | undefined, projectRoot: string): string[] => {
    const vectorIndexNames = schema?.vectorIndexNames ?? [];
    const required: { message: (site: string) => string; method: CapabilityMethod }[] = [];

    if (vectorIndexNames.length > 0) {
        required.push({
            message: (site) =>
                `schema declares vector index(es) ${vectorIndexNames.map((name) => `"${name}"`).join(", ")} but nothing chains .vectors(...) onto defineApp() ` +
                `(composed in: ${site}) — \`ctx.vectors\` is then a throwing stub and buildWorkerOptions rejects EVERY request, /_lunora/health included. ` +
                `Add \`.vectors((env) => ({ ${String(vectorIndexNames[0])}: env.<BINDING> }))\` to the chain.`,
            method: "vectors",
        });
    }

    if (schema?.hasD1GlobalTable) {
        required.push({
            message: (site) =>
                `schema declares .global() table(s) but nothing chains .global(...) onto defineApp() (composed in: ${site}) — the shard then has no global writer, ` +
                `so every read or write of a global table throws INTERNAL ("requires a globalDb writer"). ` +
                `Add \`.global({ d1: (env) => env.DB })\` to the chain.`,
            method: "global",
        });
    }

    // The Hyperdrive flavour of the same requirement: a different builder
    // method, the same missing `globalDb` and the same INTERNAL throw.
    //
    // The remediation is the shape `HyperdriveGlobalDeclaration` actually takes
    // (`@lunora/codegen`'s `emit-app.ts`): `engine` plus an `exec` built from the
    // binding, NOT a `hyperdrive: (env) => env.HYPERDRIVE` selector like the D1
    // line above. A blocking error whose suggested fix does not compile costs the
    // user the same round trip the error was meant to save.
    if (schema?.hasHyperdriveGlobalTable) {
        required.push({
            message: (site) =>
                `schema declares .global({ backend: "hyperdrive" }) table(s) but nothing chains .hyperdriveGlobal(...) onto defineApp() (composed in: ${site}) — ` +
                `the shard then has no global writer, so every read or write of those tables throws INTERNAL. ` +
                `Add \`.hyperdriveGlobal({ engine: "postgres", exec: (env) => buildPgExec(fromPostgresJs(postgres(` +
                `env.HYPERDRIVE.connectionString))) })\` to the chain ` +
                `(\`buildPgExec\` from \`@lunora/hyperdrive/global\`, \`fromPostgresJs\` from \`@lunora/hyperdrive\`).`,
            method: "hyperdriveGlobal",
        });
    }

    if (required.length === 0) {
        return [];
    }

    const scan = scanAppChains(projectRoot, new Set(required.map((entry) => entry.method)));

    if (scan === undefined) {
        return [];
    }

    return required.filter((entry) => !scan.chained.has(entry.method)).map((entry) => entry.message(scan.site));
};

/**
 * The phrase every unexported-class error carries.
 *
 * Exported because it is a CONTRACT, not prose: `lunora doctor` picks these
 * errors out of the report by substring to raise its own finding, and the
 * validator's report is a flat `string[]`. Until the report entries carry a
 * code, a copy-edit here would silently disable that check — so the copy-edit
 * has to go through this constant.
 */
const UNEXPORTED_CLASS_MARKER = "does not export it";

/**
 * What to tell a user whose entry does not export a declared class. Three cases,
 * because the wrong instruction is worse than none.
 *
 * An AUTHORED entry can simply re-export it — either by hand, or off the
 * generated app builder, which hands the class back on `app`.
 *
 * The class-A composed entry cannot: `@lunora/vite` GENERATES it, so there is no
 * file to add a line to. It forwards whatever codegen emitted, so a project's
 * OWN class gets there by being declared where codegen looks.
 *
 * Lunora's own Durable Objects are the third case: they are not `defineAgent` /
 * `defineContainer` / `defineWorkflow` declarations, so no amount of editing
 * those files makes codegen emit them, and "declare it in one of those" pointed
 * the user at hours of dead end.
 *
 * `SchedulerDO` can no longer reach here — declaring its binding is what makes
 * the composed entry re-export it, so the binding's presence is also its own
 * remedy. `SessionDO` still has no route on class-A, which is what this branch
 * now says.
 */
const remedyFor = (className: string, kind: WorkerEntry["kind"]): string => {
    if (kind !== "composed") {
        return (
            `Re-export it from the module that defines it (\`export { ${className} } from "./…";\`), ` +
            `or add it to the app builder's own export (\`export const { ${className} } = app;\`).`
        );
    }

    const composedExports = `it exports ${COMPOSED_ENTRY_DURABLE_OBJECTS.join(", ")}, SchedulerDO when its binding is declared, and every class codegen emits from your ${GENERATED_CLASS_MODULES.map((module) => `${module}.ts`).join(" / ")} declarations`;

    if (isFrameworkDurableObject(className)) {
        return (
            `\`@lunora/vite\` generates that entry — ${composedExports}, and ${className} is not among them. ` +
            `Class-A composition does not carry ${className}, so drop the binding; a project that needs it has to own its worker entry ` +
            `(add \`src/worker.ts\`, which \`lunora deploy\` bundles in place of \`main\`, and compose \`defineApp()\` there).`
        );
    }

    return (
        `\`@lunora/vite\` generates that entry, so there is no file to add a re-export to: ${composedExports}. ` +
        `Declare "${className}" in one of those and re-run \`lunora codegen\`, or drop the binding.`
    );
};

/**
 * Report every `durable_objects.bindings[].class_name` and
 * `workflows[].class_name` the worker entry does not export.
 *
 * `.scheduler(...)` and `.workflow(...)` on the generated app builder write the
 * binding and the migration entry but cannot add the `export { SchedulerDO }`
 * the entry needs, so the wiring is only half done — and wrangler refuses to
 * bundle the result: "Your Worker depends on the following Durable Objects,
 * which are not exported in your entrypoint file".
 *
 * The reason this belongs in the validator rather than being left to `wrangler
 * deploy` is what `verify` and `doctor` were reporting in the meantime. Both
 * printed a clean bill of health on a tree that could not deploy, and `verify`'s
 * own description is "validate wrangler.jsonc + codegen dry-run + tsc" — the
 * thing that is invalid IS the relationship between `wrangler.jsonc` and the
 * entry. Only `lunora build`, which shells out to `wrangler deploy --dry-run`,
 * caught it — so `verify` in a PR check went green and the deploy job failed.
 *
 * Reports nothing whenever the entry's exports cannot be decided — see
 * `readWorkerEntry`. A check that blocks must be sure.
 */
const collectUnexportedClassErrors = (wrangler: WranglerConfig, entry: WorkerEntry): string[] => {
    const exported = entry.exports;

    if (exported === undefined) {
        return [];
    }

    const declared: { className: string; label: string }[] = [];

    for (const binding of objectBindingEntries(wrangler.durable_objects?.bindings)) {
        // A binding naming a class in ANOTHER script is that script's to export;
        // only same-script bindings constrain this entry.
        if (typeof binding.class_name === "string" && binding.class_name.length > 0 && binding.script_name === undefined) {
            declared.push({ className: binding.class_name, label: "durable_objects.bindings" });
        }
    }

    for (const workflow of iterableEntries(wrangler.workflows)) {
        // Same `script_name` carve-out as the durable-object bindings above:
        // Cloudflare lets a workflow binding target a class in ANOTHER Worker,
        // which that script exports, not this entry.
        if (typeof workflow?.class_name === "string" && workflow.class_name.length > 0 && workflow.script_name === undefined) {
            declared.push({ className: workflow.class_name, label: "workflows" });
        }
    }

    const missing = declared.filter((candidate) => !exported.has(candidate.className));

    return missing.map(
        (missed) =>
            `${missed.label} declares class "${missed.className}" but the ` +
            `${entry.kind === "composed" ? "composed class-A worker entry" : "worker entry"} (${entry.path}) ${UNEXPORTED_CLASS_MARKER} — ` +
            // The noun follows the LABEL, not the check: `workflows[]` names a
            // WorkflowEntrypoint, and calling it a Durable Object sent readers
            // looking for a migration entry that does not apply to it.
            `wrangler refuses to bundle a Worker whose ${missed.label === "workflows" ? "Workflow" : "Durable Object"} classes are not exported. ${remedyFor(missed.className, entry.kind)}`,
    );
};

/**
 * `main` names a file `wrangler` will not find. {@link locateWorkerEntry} has
 * already decided that — build output and the class-A virtual specifier get
 * their own arms — so this only formats the `"absent"` one.
 *
 * A WARNING, not an error, and deliberately the weaker of the two — same call as
 * the `assets.directory` check below. It reports on a state a tree passes THROUGH
 * (`wrangler.jsonc` reconciled before the entry is written, an entry mid-rename),
 * and `@lunora/vite` throws on an error here, so blocking would stop `lunora dev`
 * on a project that is one keystroke from correct.
 */
const collectMissingEntryWarning = (location: WorkerEntryLocation): string[] => {
    if (location?.origin !== "absent") {
        return [];
    }

    // `existsSync` decided this, and it answers `false` for an unreadable parent
    // directory too — so the wording says what was observed, not that the file
    // is definitely gone.
    return [
        `main is set but no readable file is there (looked in ${location.path}) — wrangler cannot resolve the worker entry, so a deploy will fail there. ` +
            `Point main at the entry that composes your app, or remove it to fall back to the conventional locations.`,
    ];
};

/**
 * File-system aware variant: reads `wrangler.jsonc`/`wrangler.json` from
 * the given project root, discovers the schema (if any), and delegates to
 * `validateWranglerConfig`. Returns the legacy
 * `{ problems, wranglerPath }` shape plus the structured `report`.
 */
const validateWranglerProject = (options: WranglerProjectValidationOptions): WranglerProjectValidationResult => {
    const schemaDirectory = options.schemaDir ?? "lunora";
    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        const message = `wrangler.jsonc not found in ${options.projectRoot}; create one declaring at least the SHARD durable object binding.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath: undefined,
        };
    }

    const { parsed: wrangler } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (wrangler === undefined) {
        const message = `failed to parse ${wranglerPath} as JSONC.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath,
        };
    }

    // Resolved ONCE for the FS-aware checks below, straight from the raw
    // `wrangler` — kept independent of `validateWranglerConfig`'s own
    // equivalent merge (called with `options.environment` a few lines down)
    // rather than fed this result, so there is exactly one merge input
    // (`wrangler` unmerged) and no risk of double-merging an already-merged
    // config, which would look up `merged.env` and find nothing.
    const { error: environmentError, merged: resolvedWrangler } = mergeWranglerEnvironment(wrangler, options.environment);

    if (environmentError !== undefined) {
        return {
            problems: [environmentError],
            report: { errors: [environmentError], valid: false, warnings: [] },
            wranglerPath,
        };
    }

    // Surface a parse failure as a warning rather than swallowing it — codegen
    // reports the actionable error elsewhere, but a complete miss is hard to debug.
    const { error: schemaError, info: schemaInfo } = discoverSchemaInfo(options.projectRoot, schemaDirectory);
    const report = validateWranglerConfig(wrangler, schemaInfo, options.environment);

    if (schemaError !== undefined) {
        report.warnings.push(`schema parse failed in ${schemaDirectory}/schema.ts: ${schemaError}`);
    }

    const configDirectory = dirname(wranglerPath);

    // Both are FS-aware checks, so neither could run in `validateWranglerConfig`
    // above. A local-path container image must point at an existing Dockerfile
    // (wrangler resolves it relative to the config file; registry references are
    // left to wrangler). And every declared Durable Object / Workflow class must
    // be exported by the worker entry, or wrangler refuses to bundle — an error
    // rather than a warning because `collectValueExports` reports nothing unless
    // it is certain, so what reaches here is a fact, and a warning meant `verify`
    // exited 0 on a tree `lunora build` rejects.
    // `undefined` means the entry cannot be decided (no resolvable file, or one
    // that does not parse), and the export check then reports nothing.
    const entryLocation = locateWorkerEntry(resolvedWrangler.main, options.projectRoot, wranglerPath);
    const workerEntry = readWorkerEntry(entryLocation, options.projectRoot, schemaDirectory);

    report.errors.push(...collectContainerImageErrors(resolvedWrangler.containers ?? [], configDirectory, wranglerPath));
    report.warnings.push(...collectMissingEntryWarning(entryLocation));

    if (workerEntry !== undefined) {
        report.errors.push(...collectUnexportedClassErrors(resolvedWrangler, workerEntry));
    }

    // Deliberately outside that guard: it reads the project, and an unresolvable
    // entry (class-A's virtual `main`) says nothing about the vector bindings.
    report.errors.push(...collectUnchainedCapabilityErrors(schemaInfo, options.projectRoot));

    // FS-aware: `assets.directory` is created by the client build, so it may
    // legitimately not exist at validation time (pre-build). Surface a *warning*
    // (never an error) so pre-build validation flows aren't broken — mirrors the
    // container-image existence check above, but downgraded to a warning.
    const assetsDirectory = resolvedWrangler.assets?.directory;

    if (typeof assetsDirectory === "string" && assetsDirectory.length > 0) {
        const resolved = assetsDirectory.startsWith("/") ? assetsDirectory : join(configDirectory, assetsDirectory);

        if (!existsSync(resolved)) {
            report.warnings.push(`assets.directory "${assetsDirectory}" does not exist yet — it is created by the client build; run the build before deploy`);
        }
    }

    report.valid = report.errors.length === 0;

    return {
        problems: report.errors,
        report,
        wranglerPath,
    };
};

export type { WranglerProjectValidationOptions, WranglerProjectValidationResult };
export { UNEXPORTED_CLASS_MARKER, validateWranglerProject };
