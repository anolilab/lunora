/**
 * Zero-config binding inference for Cirrus.
 *
 * Mirrors the technique voidzero's `void` plugin uses for Cloudflare apps:
 * detect from code which resources a project uses, then reconcile the implied
 * bindings into `wrangler.jsonc` instead of making the user hand-write them.
 *
 * For Cirrus the authoritative, *safe* signal is the worker entry's Durable
 * Object **exports**. wrangler refuses to deploy a `durable_objects` binding
 * whose `class_name` is not exported by the worker, so binding provisioning is
 * driven strictly by which DO classes the entry actually exports — write
 * `export const ShardDO = …` and the binding appears. Capability imports
 * (`@cirrus/auth`, `@cirrus/scheduler`, `@cirrus/storage`, `@cirrus/payment`)
 * are softer signals: a project can import `@cirrus/auth` with D1-backed
 * sessions and never wire a `SessionDO`, so those drive *hints*, not writes.
 * `@cirrus/payment` is softer still — it has no binding at all (payment state
 * rides the app's existing `ShardDO` via `ctx.db`), so its only config need is
 * the provider secret pair the user must put in `.dev.vars`, which the
 * scaffolder can't fabricate; we surface that as a hint. `.global()` schemas
 * drive the `DB` D1 binding (D1 is not a Durable Object, so it has no class).
 */
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { init as initLexer, parse as lexModule } from "es-module-lexer";

import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import join from "./path";
import { discoverSchemaInfo } from "./schema-info";
import type { WorkflowIR } from "./workflow-info";
import { discoverWorkflowInfo } from "./workflow-info";
import { readWranglerJsonc, WRANGLER_FILES } from "./wrangler-path";

/** Source file extensions worth scanning for capability signals. */
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/** Directories never worth descending into during a capability scan. */
const IGNORED_DIRECTORIES = new Set([".cirrus-cache", ".git", ".wrangler", "_generated", "dist", "node_modules"]);

/** Directories scanned for capability signals when the caller does not override. */
const DEFAULT_SCAN_DIRECTORIES = ["cirrus", "src"] as const;

/** Worker-entry candidates probed when `wrangler.main` is absent. */
const WORKER_ENTRY_FALLBACKS = ["src/server/index.ts", "src/server/index.tsx", "src/index.ts", "src/worker.ts"] as const;

/**
 * Canonical Durable Object class → binding name. wrangler requires the worker
 * to export a class of this exact name, so detection keys on the class name.
 */
const DURABLE_OBJECT_BINDINGS = {
    SchedulerDO: "SCHEDULER",
    SessionDO: "SESSION",
    ShardDO: "SHARD",
} as const;

type DurableObjectClass = keyof typeof DURABLE_OBJECT_BINDINGS;

const DURABLE_OBJECT_CLASSES = Object.keys(DURABLE_OBJECT_BINDINGS) as DurableObjectClass[];

/**
 * Matches a *type-only* export of each DO class — `export type ShardDO` or the
 * inline `export { type ShardDO }` form. `es-module-lexer` lists the class name
 * as an export in both cases even though it compiles away, so a candidate name
 * is only treated as a real runtime export when this pattern does NOT match.
 * Without this, a binding would reference a class wrangler can't find at deploy.
 */
const TYPE_ONLY_EXPORT_PATTERNS: Record<DurableObjectClass, RegExp> = {
    SchedulerDO: /\btype\s+SchedulerDO\b/,
    SessionDO: /\btype\s+SessionDO\b/,
    ShardDO: /\btype\s+ShardDO\b/,
};

const ENV_DB_PATTERN = /\benv\s*\.\s*DB\b/;
const ENV_AI_PATTERN = /\benv\s*\.\s*AI\b/;
const TYPE_ONLY_IMPORT_PATTERN = /^\s*import\s+type\b/;
const IMPORT_AUTH_PATTERN = /\bfrom\s+["']@cirrus\/auth["']/;
const IMPORT_SCHEDULER_PATTERN = /\bfrom\s+["']@cirrus\/scheduler["']/;
const IMPORT_STORAGE_PATTERN = /\bfrom\s+["']@cirrus\/storage["']/;
const IMPORT_AI_PATTERN = /\bfrom\s+["']@cirrus\/ai["']/;
const IMPORT_PAYMENT_PATTERN = /\bfrom\s+["']@cirrus\/payment["']/;
// New Cloudflare-coverage binding capabilities. The canonical import-source →
// wrangler-key → provisioning table (see plans 027/028/031/032/035/036):
//   @cirrus/kv         → kv_namespaces             → hint (un-mintable namespace id)
//   @cirrus/hyperdrive → hyperdrive                → hint (un-mintable remote id)
//   @cirrus/browser    → browser                   → self-describing (binding name only)
//   @cirrus/images     → images                    → self-describing (binding name only)
//   @cirrus/analytics  → analytics_engine_datasets → self-describing (dataset == binding name)
//   @cirrus/pipelines  → pipelines                 → hint (un-mintable remote pipeline name)
const IMPORT_KV_PATTERN = /\bfrom\s+["']@cirrus\/kv["']/;
const IMPORT_HYPERDRIVE_PATTERN = /\bfrom\s+["']@cirrus\/hyperdrive["']/;
const IMPORT_BROWSER_PATTERN = /\bfrom\s+["']@cirrus\/browser["']/;
const IMPORT_IMAGES_PATTERN = /\bfrom\s+["']@cirrus\/images["']/;
const IMPORT_ANALYTICS_PATTERN = /\bfrom\s+["']@cirrus\/analytics["']/;
const IMPORT_PIPELINES_PATTERN = /\bfrom\s+["']@cirrus\/pipelines["']/;

/**
 * The provider secret pairs `@cirrus/payment` reads at runtime. The package is
 * provider-agnostic (Stripe-or-Polar, Convex parity); since we can't tell which
 * adapter a project wires from the import alone, the hint names both pairs so
 * the user knows exactly which secrets belong in `.dev.vars`.
 */
const PAYMENT_PROVIDER_SECRETS = "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Stripe) or POLAR_ACCESS_TOKEN + POLAR_WEBHOOK_SECRET (Polar)";

interface DurableObjectSpec {
    binding: string;
    className: string;
}

/**
 * A `defineContainer` declaration plus whether its generated DO class is
 * exported by the worker entry. Only exported containers are safe to
 * provision — wrangler rejects a `containers[].class_name` (and its Durable
 * Object binding) that the worker doesn't export.
 */
interface InferredContainer extends ContainerIR {
    exported: boolean;
}

/**
 * A `defineWorkflow` declaration plus whether its generated
 * `WorkflowEntrypoint` class is exported by the worker entry. Only exported
 * workflows are safe to provision — wrangler rejects a `workflows[].class_name`
 * the worker doesn't export. Workflows are NOT Durable Objects, so this never
 * implies a `durable_objects` binding or migration.
 */
interface InferredWorkflow extends WorkflowIR {
    exported: boolean;
}

interface InferredBindings {
    /** Containers declared in `cirrus/containers.ts` (exported or not — see {@link InferredContainer.exported}). */
    containers: InferredContainer[];
    /** Durable Objects the worker entry exports → safe to bind. */
    durableObjects: DurableObjectSpec[];
    /** Schema declares a `.global()` table → needs the `DB` D1 binding. */
    needsD1: boolean;
    /** Human-readable provenance for each inferred binding / hint, for logging. */
    signals: string[];
    /** `@cirrus/ai` is imported or `env.AI` is used → needs the `ai` Workers AI binding. */
    usesAi: boolean;
    /** `@cirrus/analytics` is imported → self-describing `analytics_engine_datasets` binding (auto-writeable). */
    usesAnalytics: boolean;
    /** `@cirrus/auth` is imported (sessions may be D1- or `SessionDO`-backed). */
    usesAuth: boolean;
    /** `@cirrus/browser` is imported → self-describing `browser` binding (auto-writeable). */
    usesBrowser: boolean;
    /** `@cirrus/hyperdrive` is imported (binding needs an un-mintable remote `id`; hint-only). */
    usesHyperdrive: boolean;
    /** `@cirrus/images` is imported → self-describing `images` binding (auto-writeable). */
    usesImages: boolean;
    /** `@cirrus/kv` is imported (namespace binding name + id are user-defined; hint-only). */
    usesKv: boolean;
    /** `@cirrus/payment` is imported (provider secrets must be set in `.dev.vars`; no binding). */
    usesPayment: boolean;
    /** `@cirrus/pipelines` is imported (binding needs an un-mintable remote pipeline name; hint-only). */
    usesPipelines: boolean;
    /** `@cirrus/scheduler` is imported. */
    usesScheduler: boolean;
    /** `@cirrus/storage` is imported (R2 bucket binding name is user-defined). */
    usesStorage: boolean;
    /** Workflows declared in `cirrus/workflows.ts` (exported or not — see {@link InferredWorkflow.exported}). */
    workflows: InferredWorkflow[];
}

/** Which capabilities a unit of source imports. Pure value, no mutation. */
interface Capabilities {
    needsD1: boolean;
    usesAi: boolean;
    usesAnalytics: boolean;
    usesAuth: boolean;
    usesBrowser: boolean;
    usesHyperdrive: boolean;
    usesImages: boolean;
    usesKv: boolean;
    usesPayment: boolean;
    usesPipelines: boolean;
    usesScheduler: boolean;
    usesStorage: boolean;
}

const NO_CAPABILITIES: Capabilities = {
    needsD1: false,
    usesAi: false,
    usesAnalytics: false,
    usesAuth: false,
    usesBrowser: false,
    usesHyperdrive: false,
    usesImages: false,
    usesKv: false,
    usesPayment: false,
    usesPipelines: false,
    usesScheduler: false,
    usesStorage: false,
};

const mergeCapabilities = (a: Capabilities, b: Capabilities): Capabilities => {
    return {
        needsD1: a.needsD1 || b.needsD1,
        usesAi: a.usesAi || b.usesAi,
        usesAnalytics: a.usesAnalytics || b.usesAnalytics,
        usesAuth: a.usesAuth || b.usesAuth,
        usesBrowser: a.usesBrowser || b.usesBrowser,
        usesHyperdrive: a.usesHyperdrive || b.usesHyperdrive,
        usesImages: a.usesImages || b.usesImages,
        usesKv: a.usesKv || b.usesKv,
        usesPayment: a.usesPayment || b.usesPayment,
        usesPipelines: a.usesPipelines || b.usesPipelines,
        usesScheduler: a.usesScheduler || b.usesScheduler,
        usesStorage: a.usesStorage || b.usesStorage,
    };
};

/** Map a single import source onto the capability it implies. */
const capabilityForImportSource = (source: string): Capabilities => {
    if (source === "@cirrus/auth") {
        return { ...NO_CAPABILITIES, usesAuth: true };
    }

    if (source === "@cirrus/scheduler") {
        return { ...NO_CAPABILITIES, usesScheduler: true };
    }

    if (source === "@cirrus/storage") {
        return { ...NO_CAPABILITIES, usesStorage: true };
    }

    if (source === "@cirrus/ai") {
        return { ...NO_CAPABILITIES, usesAi: true };
    }

    if (source === "@cirrus/payment") {
        return { ...NO_CAPABILITIES, usesPayment: true };
    }

    if (source === "@cirrus/kv") {
        return { ...NO_CAPABILITIES, usesKv: true };
    }

    if (source === "@cirrus/hyperdrive") {
        return { ...NO_CAPABILITIES, usesHyperdrive: true };
    }

    if (source === "@cirrus/browser") {
        return { ...NO_CAPABILITIES, usesBrowser: true };
    }

    if (source === "@cirrus/images") {
        return { ...NO_CAPABILITIES, usesImages: true };
    }

    if (source === "@cirrus/analytics") {
        return { ...NO_CAPABILITIES, usesAnalytics: true };
    }

    if (source === "@cirrus/pipelines") {
        return { ...NO_CAPABILITIES, usesPipelines: true };
    }

    return NO_CAPABILITIES;
};

/**
 * Lex imports with `es-module-lexer` and union the capability each runtime
 * source implies. Type-only imports compile away and imply nothing. Throws on
 * unparseable input so the caller can fall back to a regex sweep.
 */
const lexCapabilities = (code: string): Capabilities => {
    const [imports] = lexModule(code);

    let capabilities = NO_CAPABILITIES;

    for (const entry of imports) {
        const source = entry.n;

        if (!source || TYPE_ONLY_IMPORT_PATTERN.test(code.slice(entry.ss, entry.se))) {
            continue;
        }

        capabilities = mergeCapabilities(capabilities, capabilityForImportSource(source));
    }

    return capabilities;
};

/** Regex fallback for when `es-module-lexer` cannot parse a mid-edit file. */
const regexCapabilities = (code: string): Capabilities => {
    return {
        needsD1: false,
        usesAi: IMPORT_AI_PATTERN.test(code),
        usesAnalytics: IMPORT_ANALYTICS_PATTERN.test(code),
        usesAuth: IMPORT_AUTH_PATTERN.test(code),
        usesBrowser: IMPORT_BROWSER_PATTERN.test(code),
        usesHyperdrive: IMPORT_HYPERDRIVE_PATTERN.test(code),
        usesImages: IMPORT_IMAGES_PATTERN.test(code),
        usesKv: IMPORT_KV_PATTERN.test(code),
        usesPayment: IMPORT_PAYMENT_PATTERN.test(code),
        usesPipelines: IMPORT_PIPELINES_PATTERN.test(code),
        usesScheduler: IMPORT_SCHEDULER_PATTERN.test(code),
        usesStorage: IMPORT_STORAGE_PATTERN.test(code),
    };
};

/** Detect, for a single source file, which Cirrus capabilities it pulls in. */
const capabilitiesFromSource = (code: string): Capabilities => {
    let capabilities: Capabilities;

    try {
        capabilities = lexCapabilities(code);
    } catch {
        capabilities = regexCapabilities(code);
    }

    return mergeCapabilities(capabilities, { ...NO_CAPABILITIES, needsD1: ENV_DB_PATTERN.test(code), usesAi: ENV_AI_PATTERN.test(code) });
};

/** Recursively collect scannable source files under `directory`. */
const collectSourceFiles = (directory: string, accumulator: string[]): void => {
    let entries: Dirent[];

    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) {
                collectSourceFiles(join(directory, entry.name), accumulator);
            }

            continue;
        }

        const dotIndex = entry.name.lastIndexOf(".");

        if (dotIndex !== -1 && SOURCE_EXTENSIONS.has(entry.name.slice(dotIndex))) {
            accumulator.push(join(directory, entry.name));
        }
    }
};

interface InferOptions {
    projectRoot: string;
    /** Directories (relative to root) to scan. Defaults to `cirrus` + `src`. */
    scanDirs?: ReadonlyArray<string>;
    /** Cirrus source directory holding `schema.ts`. Defaults to `cirrus`. */
    schemaDir?: string;
}

/** Read the worker entry path from `wrangler.main`, or probe known fallbacks. */
const resolveWorkerEntry = (projectRoot: string): string | undefined => {
    for (const candidate of WRANGLER_FILES) {
        const wranglerPath = join(projectRoot, candidate);

        if (!existsSync(wranglerPath)) {
            continue;
        }

        const { parsed } = readWranglerJsonc<{ main?: string }>(wranglerPath);
        const main = parsed?.main;

        if (typeof main === "string" && existsSync(join(projectRoot, main))) {
            return join(projectRoot, main);
        }

        break;
    }

    for (const fallback of WORKER_ENTRY_FALLBACKS) {
        const fullPath = join(projectRoot, fallback);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

/**
 * The Durable Object classes the worker entry exports. Uses `es-module-lexer`'s
 * export list so every form is covered (`export const ShardDO`, `export {
 * SchedulerDO } from "./do"`, aliases). These are the only DO classes safe to
 * bind, since wrangler validates that a binding's `class_name` is exported.
 */
const detectExportedDurableObjects = (entryPath: string): DurableObjectSpec[] => {
    const code = readFileSync(entryPath, "utf8");
    let exportedNames: Set<string>;

    try {
        const [, exports] = lexModule(code);

        exportedNames = new Set(exports.map((entry) => entry.n));
    } catch {
        exportedNames = new Set(DURABLE_OBJECT_CLASSES.filter((className) => new RegExp(String.raw`\bexport\b[^\n;]*\b${className}\b`).test(code)));
    }

    // A candidate counts only when it is exported as a runtime value — an
    // inline `export { type ShardDO }` lists the name but compiles away, and
    // binding it would make `wrangler deploy` fail on the missing class.
    return DURABLE_OBJECT_CLASSES.filter((className) => exportedNames.has(className) && !TYPE_ONLY_EXPORT_PATTERNS[className].test(code)).map((className) => {
        return {
            binding: DURABLE_OBJECT_BINDINGS[className],
            className,
        };
    });
};

/**
 * Matches an `export * from "…/_generated/containers"` (with or without the
 * `.js` extension) — the conventional way a worker entry re-exports every
 * generated container class at once. `es-module-lexer` lists the module
 * request but not the names a star re-export forwards, so the path itself is
 * the signal that all generated container classes are exported.
 */
const CONTAINERS_STAR_REEXPORT_PATTERN = /\bexport\s*\*\s*from\s*["'][^"']*_generated\/containers(?:\.js)?["']/;

/**
 * Whether the worker entry exports each generated container class: a named
 * export of the class (covered by `es-module-lexer`'s export list) or the
 * conventional `export * from "./cirrus/_generated/containers"` star
 * re-export. Mirrors `detectExportedDurableObjects` — exports are the only
 * safe provisioning signal, since wrangler validates `class_name` against the
 * worker's exports at deploy.
 */
const detectContainerExports = (entryPath: string | undefined, containers: ReadonlyArray<ContainerIR>): InferredContainer[] => {
    if (containers.length === 0) {
        return [];
    }

    if (entryPath === undefined) {
        return containers.map((container) => {
            return { ...container, exported: false };
        });
    }

    const code = readFileSync(entryPath, "utf8");
    const starReexport = CONTAINERS_STAR_REEXPORT_PATTERN.test(code);

    let exportedNames: Set<string>;

    try {
        const [, exports] = lexModule(code);

        exportedNames = new Set(exports.map((entry) => entry.n));
    } catch {
        exportedNames = new Set(
            containers.map((container) => container.className).filter((className) => new RegExp(String.raw`\bexport\b[^\n;]*\b${className}\b`).test(code)),
        );
    }

    return containers.map((container) => {
        return { ...container, exported: starReexport || exportedNames.has(container.className) };
    });
};

/**
 * Matches an `export * from "…/_generated/workflows"` (with or without the
 * `.js` extension) — the conventional way a worker entry re-exports every
 * generated `WorkflowEntrypoint` class at once. `es-module-lexer` lists the
 * module request but not the names a star re-export forwards, so the path
 * itself is the signal that all generated workflow classes are exported.
 */
const WORKFLOWS_STAR_REEXPORT_PATTERN = /\bexport\s*\*\s*from\s*["'][^"']*_generated\/workflows(?:\.js)?["']/;

/**
 * Whether the worker entry exports each generated `WorkflowEntrypoint` class: a
 * named export of the class or the conventional
 * `export * from "./cirrus/_generated/workflows"` star re-export. Mirrors
 * {@link detectContainerExports} — exports are the only safe provisioning
 * signal, since wrangler validates `class_name` against the worker's exports.
 */
const detectWorkflowExports = (entryPath: string | undefined, workflows: ReadonlyArray<WorkflowIR>): InferredWorkflow[] => {
    if (workflows.length === 0) {
        return [];
    }

    if (entryPath === undefined) {
        return workflows.map((workflow) => {
            return { ...workflow, exported: false };
        });
    }

    const code = readFileSync(entryPath, "utf8");
    const starReexport = WORKFLOWS_STAR_REEXPORT_PATTERN.test(code);

    let exportedNames: Set<string>;

    try {
        const [, exports] = lexModule(code);

        exportedNames = new Set(exports.map((entry) => entry.n));
    } catch {
        exportedNames = new Set(
            workflows.map((workflow) => workflow.className).filter((className) => new RegExp(String.raw`\bexport\b[^\n;]*\b${className}\b`).test(code)),
        );
    }

    return workflows.map((workflow) => {
        return { ...workflow, exported: starReexport || exportedNames.has(workflow.className) };
    });
};

/**
 * The schema-derived signal: a `.global()` table needs the `DB` D1 binding.
 * Delegates to the shared `discoverSchemaInfo` so inference and the wrangler
 * validator read the exact same fact. A missing or unparseable schema yields
 * `false` — codegen surfaces the actionable error elsewhere.
 */
const schemaNeedsD1 = (projectRoot: string, schemaDirectory: string): boolean => discoverSchemaInfo(projectRoot, schemaDirectory).info?.hasGlobalTable ?? false;

/** Union the capabilities imported across every scanned source file. */
const scanCapabilities = (projectRoot: string, scanDirectories: ReadonlyArray<string>): Capabilities => {
    let merged = NO_CAPABILITIES;

    for (const relativeDirectory of scanDirectories) {
        const absolute = join(projectRoot, relativeDirectory);

        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            continue;
        }

        const files: string[] = [];

        collectSourceFiles(absolute, files);

        for (const file of files) {
            merged = mergeCapabilities(merged, capabilitiesFromSource(readFileSync(file, "utf8")));
        }
    }

    return merged;
};

/** Provenance lines for declared DO containers / workflows. */
const describeDeclaredExports = (containers: ReadonlyArray<InferredContainer>, workflows: ReadonlyArray<InferredWorkflow>): string[] => [
    ...containers.map((container) =>
        container.exported
            ? `${container.bindingName}/${container.className} (container "${container.exportName}" declared and exported)`
            : `hint: container "${container.exportName}" is declared but ${container.className} is not exported by the worker entry — add \`export * from "./cirrus/_generated/containers"\``,
    ),
    ...workflows.map((workflow) =>
        workflow.exported
            ? `${workflow.bindingName}/${workflow.className} (workflow "${workflow.exportName}" declared and exported)`
            : `hint: workflow "${workflow.exportName}" is declared but ${workflow.className} is not exported by the worker entry — add \`export * from "./cirrus/_generated/workflows"\``,
    ),
];

/**
 * Provenance lines implied by capability imports. Each entry is a predicate on
 * the scanned capabilities plus the signal it contributes when true.
 */
const describeCapabilitySignals = (capabilities: Capabilities, exported: ReadonlySet<string>): string[] => {
    const rules: ReadonlyArray<[boolean, string]> = [
        [capabilities.usesAi, "AI (@cirrus/ai imported or env.AI used)"],
        [
            capabilities.usesAuth && !exported.has("SessionDO"),
            "hint: @cirrus/auth is imported but no SessionDO is exported (sessions are D1-backed, or export SessionDO for DO-backed sessions)",
        ],
        [capabilities.usesScheduler && !exported.has("SchedulerDO"), "hint: @cirrus/scheduler is imported but no SchedulerDO is exported by the worker entry"],
        [capabilities.usesStorage, "hint: @cirrus/storage is imported; add an r2_buckets binding (bucket binding names are user-defined)"],
        [capabilities.usesPayment, `hint: @cirrus/payment is imported; set the provider secrets in .dev.vars — ${PAYMENT_PROVIDER_SECRETS}`],
        // Self-describing bindings: the binding name is the whole config (no remote
        // id to mint), so reconcile auto-writes them like the DO/D1 bindings.
        [capabilities.usesBrowser, "browser (@cirrus/browser imported) — self-describing { binding: BROWSER }"],
        [capabilities.usesImages, "images (@cirrus/images imported) — self-describing { binding: IMAGES }"],
        [capabilities.usesAnalytics, "analytics_engine_datasets (@cirrus/analytics imported) — self-describing { binding: ANALYTICS, dataset }"],
        // Hint bindings: each needs a remote resource Cirrus can't fabricate (a KV
        // namespace id, a Hyperdrive id, a Pipelines pipeline name), so they surface
        // as hints — never an auto-write — exactly like R2's user-defined bucket name.
        [
            capabilities.usesKv,
            "hint: @cirrus/kv is imported; add a kv_namespaces binding ({ binding, id }) and pass env.<BINDING> to createKv() — the namespace id can't be auto-provisioned",
        ],
        [
            capabilities.usesHyperdrive,
            "hint: @cirrus/hyperdrive is imported; run 'wrangler hyperdrive create' and add a 'hyperdrive' binding ({ binding, id }) — the id can't be auto-provisioned",
        ],
        [
            capabilities.usesPipelines,
            "hint: @cirrus/pipelines is imported; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, pipeline }) — the pipeline resource can't be auto-provisioned",
        ],
    ];

    return rules.filter(([active]) => active).map(([, signal]) => signal);
};

/** Build the human-readable provenance list. */
const describeSignals = (
    durableObjects: DurableObjectSpec[],
    needsD1: boolean,
    capabilities: Capabilities,
    containers: ReadonlyArray<InferredContainer> = [],
    workflows: ReadonlyArray<InferredWorkflow> = [],
): string[] => {
    const exported = new Set(durableObjects.map((object) => object.className));
    const signals = durableObjects.map((object) => `${object.binding}/${object.className} (exported by worker entry)`);

    if (needsD1) {
        signals.push("DB (.global() table declared)");
    }

    signals.push(...describeDeclaredExports(containers, workflows), ...describeCapabilitySignals(capabilities, exported));

    return signals;
};

/**
 * Scan a Cirrus project and report which Cloudflare bindings its code implies.
 * Read-only: performs no writes. Binding provisioning is driven by the worker
 * entry's Durable Object exports plus the schema's D1 need; capability imports
 * surface as hints.
 */
const inferCirrusBindings = async (options: InferOptions): Promise<InferredBindings> => {
    await initLexer;

    const schemaDirectory = options.schemaDir ?? "cirrus";
    const scanDirectories = options.scanDirs ?? DEFAULT_SCAN_DIRECTORIES;

    const capabilities = scanCapabilities(options.projectRoot, scanDirectories);
    const entryPath = resolveWorkerEntry(options.projectRoot);
    const durableObjects = entryPath ? detectExportedDurableObjects(entryPath) : [];
    const needsD1 = capabilities.needsD1 || schemaNeedsD1(options.projectRoot, schemaDirectory);
    const containers = detectContainerExports(entryPath, discoverContainerInfo(options.projectRoot, schemaDirectory).containers);
    const workflows = detectWorkflowExports(entryPath, discoverWorkflowInfo(options.projectRoot, schemaDirectory).workflows);

    return {
        containers,
        durableObjects,
        needsD1,
        signals: describeSignals(durableObjects, needsD1, capabilities, containers, workflows),
        usesAi: capabilities.usesAi,
        usesAnalytics: capabilities.usesAnalytics,
        usesAuth: capabilities.usesAuth,
        usesBrowser: capabilities.usesBrowser,
        usesHyperdrive: capabilities.usesHyperdrive,
        usesImages: capabilities.usesImages,
        usesKv: capabilities.usesKv,
        usesPayment: capabilities.usesPayment,
        usesPipelines: capabilities.usesPipelines,
        usesScheduler: capabilities.usesScheduler,
        usesStorage: capabilities.usesStorage,
        workflows,
    };
};

export type { DurableObjectClass, DurableObjectSpec, InferOptions, InferredBindings, InferredContainer, InferredWorkflow };
export { inferCirrusBindings };
