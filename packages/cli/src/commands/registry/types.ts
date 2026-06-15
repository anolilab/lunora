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
    /** Override the remote registry source base (default gh:anolilab/lunora/registry). */
    source?: string;
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

export type {
    AddCommandOptions,
    AddCommandResult,
    ReconcileOptions,
    ReconcileOutcome,
    RegistryBinding,
    RegistryEnvVariable,
    RegistryFile,
    RegistryManifest,
    ResolvedItem,
};
export { emptyResult };
