/**
 * Shared types for the component-registry commands (`lunora registry
 * add|list|view|build`). The manifest shape mirrors `registry.json`; the option
 * / result types are shared across the four command orchestrators.
 */
import type { Logger } from "../../util/logger";

/** A single file the item scaffolds into the project. */
interface RegistryFile {
    /** Source path inside the item dir (e.g. `schema.ts`). */
    from: string;
    /** Merge strategy. `create-or-skip` writes whole files; `schema-extension` AST-merges schema.ts. */
    merge: "create-or-skip" | "schema-extension";
    /** Destination relative to the project root (e.g. `lunora/ratelimit/index.ts`). */
    to: string;
}

/** A wrangler.jsonc binding addition. `path` is the jsonc key path; `value` the value to set. */
interface RegistryBinding {
    path: ReadonlyArray<string>;
    value: unknown;
}

/**
 * An environment variable an item needs. Scaffolded into `.dev.vars` (Workers'
 * local-secrets file) on add — non-secrets get their `value`; secrets get an
 * empty placeholder and a reminder to run `wrangler secret put` for production.
 */
interface RegistryEnvVariable {
    /** Human note on what the variable is for. */
    description?: string;
    /** The variable name (e.g. `RESEND_API_KEY`). */
    name: string;
    /** Mark as a secret: never write a value, only a placeholder, and remind about prod. Defaults to `true` when no `value` is given. */
    secret?: boolean;
    /** A default/example value for non-secret vars. */
    value?: string;
}

/** A re-export the item needs injected into the worker entry point (class-B/C only). */
interface EntrypointReexport {
    /** Module specifier (e.g. `"_generated/workflows"` → `export * from "./lunora/_generated/workflows"`). */
    module: string;
    /** Optional JS comment placed above the re-export line. */
    comment?: string;
}

/** The `registry.json` manifest shape. */
interface RegistryManifest {
    /** wrangler.jsonc additions (best-effort structural edits). */
    bindings?: ReadonlyArray<RegistryBinding>;
    /** npm deps to add to the project package.json (name → version range). */
    deps?: Readonly<Record<string, string>>;
    description?: string;
    /** npm devDependencies to add to the project package.json. */
    devDependencies?: Readonly<Record<string, string>>;
    /** Post-install guidance printed after the item is added (per-item next steps). */
    docs?: string;
    /** Worker-entry re-exports the item needs (class-B/C only). */
    entrypointReexports?: ReadonlyArray<EntrypointReexport>;
    /** Environment variables the item needs; scaffolded into `.dev.vars`. */
    envVars?: ReadonlyArray<RegistryEnvVariable>;
    files: ReadonlyArray<RegistryFile>;
    name: string;
    /** Other registry items this one depends on (resolved transitively, deps first). */
    requires?: ReadonlyArray<string>;
    /** Short human-readable label (distinct from the longer `description`). */
    title?: string;
}

interface AddCommandOptions {
    /** Bypass the `--source` safety gate (matches init). */
    allowUnsafeSource?: boolean;
    /** `registry build --check`: verify the index is current instead of rewriting it. */
    check?: boolean;
    /** Inject a confirmer for non-interactive callers / tests. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    /** Preview the file-level changes (a content diff) and write nothing. */
    diff?: boolean;
    /** Print the plan and stop without writing anything. */
    dryRun?: boolean;
    /** Local registry root (offline / tests). Expects per-item subdirs, each with a `registry.json`. */
    from?: string;
    /** Emit a JSON snapshot of the plan/result. */
    json?: boolean;
    /** `--list`: enumerate available items instead of adding. */
    list?: boolean;
    logger: Logger;
    /** Item names to add (positional args). */
    names: ReadonlyArray<string>;
    /** `registry build` output path for the generated catalog (defaults to the root's `index.json`). */
    out?: string;
    /** Force-overwrite existing files (take the incoming copy) instead of skipping/conflicting. */
    overwrite?: boolean;
    /** Override the git ref (branch, tag, or commit) items are fetched from (default: version-derived); appended to the `source` base when that is set. Ignored when `from` is set. */
    ref?: string;
    /** Override the remote registry source base (default gh:anolilab/lunora/registry). */
    source?: string;

    /**
     * Customize each resolved manifest after it is loaded but before the plan is
     * printed / reconciled — used to inject user-chosen values into otherwise
     * static manifests (e.g. the R2 `bucket_name` the init storage prompt asks
     * for). Applied to every item; return the manifest unchanged to leave it as-is.
     */
    transformManifest?: (manifest: RegistryManifest) => RegistryManifest;
    /** Skip the package.json mutation confirmation prompt. */
    yes?: boolean;
}

interface AddCommandResult {
    /** Bindings written to wrangler.jsonc. */
    bindings: ReadonlyArray<string>;
    code: number;
    /** Deps added to package.json. */
    deps: ReadonlyArray<string>;
    /** Files skipped because they already existed. */
    skipped: ReadonlyArray<string>;
    /** Files written (absolute paths). */
    written: ReadonlyArray<string>;
}

/** One resolved item: its parsed manifest plus the (possibly staged) directory it lives in. */
interface ResolvedItem {
    directory: string;
    manifest: RegistryManifest;
}

/** Outcome of reconciling a single file. */
type ReconcileOutcome = { kind: "skipped" | "written"; path: string };
/** Per-run reconcile modifiers. */
type ReconcileOptions = { diff?: boolean; overwrite?: boolean };

/** An empty (no-op) command result; spread to set a non-zero `code`. */
const emptyResult = (): AddCommandResult => {
    return { bindings: [], code: 0, deps: [], skipped: [], written: [] };
};

/**
 * Return a copy of `manifest` with `field` set to `fieldValue` on the binding
 * entry under the `section` (e.g. `r2_buckets`) whose `match.key` equals
 * `match.value` (e.g. `{ key: "binding", value: "UPLOADS" }`). Every other
 * section, entry, and the rest of the manifest are preserved, and it no-ops when
 * no matching binding/entry exists — so it's safe to run over any item. Used to
 * inject user-chosen values (R2 bucket name, D1 database name, send-email
 * destination) into an item's otherwise-static manifest before it's written.
 */
const setBindingField = (
    manifest: RegistryManifest,
    section: string,
    match: { key: string; value: string },
    field: string,
    fieldValue: string,
): RegistryManifest => {
    if (!manifest.bindings) {
        return manifest;
    }

    return {
        ...manifest,
        bindings: manifest.bindings.map((binding) => {
            if (binding.path[0] !== section || !Array.isArray(binding.value)) {
                return binding;
            }

            // `RegistryBinding.value` is `unknown`; `Array.isArray` widens it to
            // `any[]`, so re-narrow to `unknown[]` before touching the entries.
            const entries = binding.value as unknown[];

            return {
                ...binding,
                value: entries.map((entry) =>
                    typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[match.key] === match.value
                        ? { ...entry, [field]: fieldValue }
                        : entry,
                ),
            };
        }),
    };
};

export type {
    AddCommandOptions,
    AddCommandResult,
    EntrypointReexport,
    ReconcileOptions,
    ReconcileOutcome,
    RegistryBinding,
    RegistryEnvVariable,
    RegistryFile,
    RegistryManifest,
    ResolvedItem,
};
export { emptyResult, setBindingField };
