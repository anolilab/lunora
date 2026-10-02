/**
 * Zero-config binding inference for Lunora.
 *
 * Mirrors the technique voidzero's `void` plugin uses for Cloudflare apps:
 * detect from code which resources a project uses, then reconcile the implied
 * bindings into `wrangler.jsonc` instead of making the user hand-write them.
 *
 * For Lunora the authoritative, *safe* signal is the worker entry's Durable
 * Object **exports**. wrangler refuses to deploy a `durable_objects` binding
 * whose `class_name` is not exported by the worker, so binding provisioning is
 * driven strictly by which DO classes the entry actually exports — write
 * `export const ShardDO = …` and the binding appears. Capability imports
 * (`@lunora/auth`, `@lunora/scheduler`, `@lunora/storage`, `@lunora/payment`)
 * are softer signals: a project can import `@lunora/auth` with D1-backed
 * sessions and never wire a `SessionDO`, so those drive *hints*, not writes.
 * `@lunora/payment` is softer still — it has no binding at all (payment state
 * rides the app's existing `ShardDO` via `ctx.db`), so its only config need is
 * the provider secret pair the user must put in `.dev.vars`, which the
 * scaffolder can't fabricate; we surface that as a hint. `.global()` schemas
 * drive the `DB` D1 binding (D1 is not a Durable Object, so it has no class).
 */
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import type { CapabilityKey, ServiceBindingIR, SourceCapabilitySignals } from "@lunora/codegen";
import { CAPABILITY_PROBES, readServiceBindings, sourceCapabilitySignals } from "@lunora/codegen";
import { init as initLexer, parse as lexModule } from "es-module-lexer";
import { Project } from "ts-morph";

import type { AgentIR } from "./agent-info";
import { discoverAgentInfo } from "./agent-info";
import artifactsBindingHint from "./artifacts-hint";
import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import { discoverFlagsInfo } from "./flags-info";
import type { SandboxToolName } from "./infer-sandbox-tools";
import { SANDBOX_TOOLS, sandboxToolImports } from "./infer-sandbox-tools";
import join from "./path";
import type { QueueIR } from "./queue-info";
import { discoverQueueInfo } from "./queue-info";
import type { SchemaInfo } from "./schema-info";
import { discoverSchemaInfo } from "./schema-info";
import type { DurableObjectClass, DurableObjectSpec } from "./worker-entry";
import {
    COMPOSED_ENTRY_DURABLE_OBJECTS,
    detectClassExports,
    detectExportedDurableObjects,
    DURABLE_OBJECT_BINDINGS,
    GENERATED_DIRECTORY,
    GENERATED_MODULE_DURABLE_OBJECTS,
    resolveWorkerEntry,
} from "./worker-entry";
import type { WorkflowIR } from "./workflow-info";
import { discoverWorkflowInfo } from "./workflow-info";

/** Source file extensions worth scanning for capability signals. */
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/** Directories never worth descending into during a capability scan. */
const IGNORED_DIRECTORIES = new Set([".git", ".lunora-cache", ".wrangler", "dist", GENERATED_DIRECTORY, "node_modules"]);

/** Directories scanned for capability signals when the caller does not override. */
const DEFAULT_SCAN_DIRECTORIES = ["lunora", "src"] as const;

const ENV_DB_PATTERN = /\benv\s*\.\s*DB\b/;
const ENV_AI_PATTERN = /\benv\s*\.\s*AI\b/;

// Provisioning behaviour per capability (see plans 027/028/031/032/035/036):
//   kv          → kv_namespaces             → hint (un-mintable namespace id)
//   hyperdrive  → hyperdrive                → hint (un-mintable remote id)
//   browser     → browser                   → self-describing (binding name only)
//   images      → images                    → self-describing (binding name only)
//   analytics   → analytics_engine_datasets → self-describing (dataset == binding name)
//   pipelines   → pipelines                 → hint (un-mintable remote pipeline name)
//   artifacts   → artifacts                 → hint (the namespace's jurisdiction is fixed at creation, so never auto-written)
//   aiSearch    → ai_search_namespaces      → self-describing (namespace "default" always exists; wrangler creates a missing one)
//   analyticsSql → analytics                → self-describing (binding name only; wrangler >= 4.145.0)

/**
 * Config's flag for each of codegen's capabilities it reports. The detection
 * facets of these rows — the package whose value import, and the `ctx.<property>`
 * whose read, marks the capability used — are NOT restated here: they are read
 * off codegen's own table ({@link CAPABILITY_PROBES}), so a handler that makes
 * codegen wire `ctx.kv` always makes config add or hint the KV binding too.
 */
const CODEGEN_CAPABILITY_FLAGS = {
    ai: "usesAi",
    aiSearch: "usesAiSearch",
    analytics: "usesAnalytics",
    analyticsSql: "usesAnalyticsSql",
    artifacts: "usesArtifacts",
    browser: "usesBrowser",
    hyperdrive: "usesHyperdrive",
    images: "usesImages",
    kv: "usesKv",
    mail: "usesMail",
    // No Cloudflare binding of its own — like `@lunora/mail`, this exists so the
    // package's declared secrets (the VAPID trio + the two FCM keys) reach
    // `.dev.vars.example` and the missing-secret pre-flight.
    notify: "usesNotify",
    payments: "usesPayment",
    pipelines: "usesPipelines",
    // Its three `R2_SQL_*` secrets are the whole config need (no binding).
    r2sql: "usesR2sql",
    scheduler: "usesScheduler",
    storage: "usesStorage",
    x402: "usesX402Pay",
} as const satisfies Partial<Record<CapabilityKey, `uses${string}`>>;

/**
 * The config-only flags: packages codegen wires no `ctx.*` helper for, so they
 * have no row in its table. A static value import or a dynamic `import()` of the
 * package is the signal.
 */
const CONFIG_ONLY_SOURCES = {
    usesAuth: "@lunora/auth",
    // The Workers CIMD transport (plan 461). No binding and no signal: it needs a
    // compatibility flag, which `lunora doctor` checks against the wrangler config
    // this inference never reads. It is commonly loaded lazily where the auth
    // instance is built, hence the dynamic-import arm.
    usesCimdWorkers: "@lunora/auth/cimd/workers",
    // The x402 charge rail is an opt-in add-on subpath (not part of the `lunorash`
    // umbrella). It implies no `.dev.vars` secret: the charge recipient is a
    // user-named `[vars]` entry — hint-only.
    usesX402Charge: "@lunora/x402/charge",
} as const;

/** The import-driven capability flag names. */
type CapabilityFlag = keyof typeof CONFIG_ONLY_SOURCES | (typeof CODEGEN_CAPABILITY_FLAGS)[keyof typeof CODEGEN_CAPABILITY_FLAGS];

/** How one flag is detected in a source file. */
interface CapabilitySource {
    /** The `ctx.<property>` read that marks it used (codegen rows that wire a ctx helper). */
    contextProperty?: string;
    /** A config-only row: a dynamic `import()` of `source` counts too. */
    dynamicImport: boolean;
    /** The package whose value import marks it used — also the name {@link packageNamesFromBindings} reports. */
    source: string;
}

/** Look a codegen capability up in its table; a key config maps but codegen dropped is a build-time bug, so fail loudly. */
const codegenProbe = (key: CapabilityKey): (typeof CAPABILITY_PROBES)[number] => {
    const probe = CAPABILITY_PROBES.find((candidate) => candidate.key === key);

    if (probe === undefined) {
        throw new Error(`@lunora/config: codegen has no "${key}" capability`);
    }

    return probe;
};

/**
 * Every import-driven capability flag → how it is detected: the codegen rows
 * derived from {@link CAPABILITY_PROBES}, then the {@link CONFIG_ONLY_SOURCES}.
 * Everything else that enumerates capabilities — the {@link Capabilities} type,
 * {@link NO_CAPABILITIES}, {@link mergeCapabilities}, and the final
 * {@link InferredBindings} return — is derived from this table.
 */
const CAPABILITY_SOURCES = Object.fromEntries([
    ...Object.entries(CODEGEN_CAPABILITY_FLAGS).map(([key, flag]) => {
        const { contextProperty, moduleSpecifier } = codegenProbe(key as CapabilityKey);

        return [flag, { contextProperty, dynamicImport: false, source: moduleSpecifier }] as const;
    }),
    ...Object.entries(CONFIG_ONLY_SOURCES).map(([flag, source]) => [flag, { dynamicImport: true, source }] as const),
]) as Readonly<Record<CapabilityFlag, CapabilitySource>>;

/** Every flag, sorted so {@link packageNamesFromBindings} reports packages in a stable order. */
const CAPABILITY_FLAGS = (Object.keys(CAPABILITY_SOURCES) as CapabilityFlag[]).toSorted((left, right) => left.localeCompare(right));

/** The packages whose static import makes a file worth parsing. */
const CAPABILITY_PACKAGES: ReadonlySet<string> = new Set(CAPABILITY_FLAGS.map((flag) => CAPABILITY_SOURCES[flag].source));

/**
 * Cheap pre-check for a `ctx.<property>` read: every form codegen recognises
 * (an access, a destructure, a renamed context) names the `ctx` property
 * somewhere, and names the helper too.
 */
const CONTEXT_PATTERN = /\bctx\b/u;
const CONTEXT_PROPERTY_PATTERN = new RegExp(
    String.raw`\b(?:${CAPABILITY_FLAGS.flatMap((flag) => CAPABILITY_SOURCES[flag].contextProperty ?? []).join("|")})\b`,
    "u",
);

/**
 * The provider secret pairs `@lunora/payment` reads at runtime. The package is
 * provider-agnostic (Stripe-or-Polar, Convex parity); since we can't tell which
 * adapter a project wires from the import alone, the hint names both pairs so
 * the user knows exactly which secrets belong in `.dev.vars`.
 */
const PAYMENT_PROVIDER_SECRETS = "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Stripe) or POLAR_ACCESS_TOKEN + POLAR_WEBHOOK_SECRET (Polar)";

/**
 * A `defineContainer` declaration plus whether its generated DO class is
 * exported by the worker entry. Only exported containers are safe to
 * provision — wrangler rejects a `containers[].class_name` (and its Durable
 * Object binding) that the worker doesn't export.
 */
type InferredContainer = ContainerIR & {
    exported: boolean;
};

/**
 * A `defineWorkflow` declaration plus whether its generated
 * `WorkflowEntrypoint` class is exported by the worker entry. Only exported
 * workflows are safe to provision — wrangler rejects an `exports.<Class>`
 * workflow the worker doesn't export. Workflows are NOT Durable Objects, so this never
 * implies a `durable_objects` binding or migration.
 */
interface InferredWorkflow extends WorkflowIR {
    exported: boolean;
}

/**
 * A `defineAgent` declaration plus whether its generated agent
 * `WorkflowEntrypoint` class (e.g. `SupportAgentWorkflow`) is exported by the
 * worker entry. An agent compiles onto a Cloudflare Workflow, so — exactly like
 * {@link InferredWorkflow} — only exported agents are safe to provision
 * (wrangler rejects an `exports.<Class>` workflow the worker doesn't export), and
 * an agent is NOT a Durable Object (no `durable_objects` binding or migration).
 */
interface InferredAgent extends AgentIR {
    exported: boolean;
}

/**
 * A queue declared in `lunora/queues.ts`. Unlike workflows, a queue needs no
 * worker-entry class export (its `queue()` handler rides `createWorker`), so
 * there is no `exported` flag — every declared queue is reconcilable into the
 * wrangler `queues.producers[]` / `queues.consumers[]`.
 */
type InferredQueue = QueueIR;

interface InferredBindings {
    /** Agents declared in `lunora/agents.ts` (exported or not — see {@link InferredAgent.exported}); reconciled into wrangler `exports`. */
    agents: InferredAgent[];
    /** Containers declared in `lunora/containers.ts` (exported or not — see {@link InferredContainer.exported}). */
    containers: InferredContainer[];
    /** Durable Objects the worker entry exports → safe to bind. */
    durableObjects: DurableObjectSpec[];

    /**
     * The wrangler `flagship[].binding` name implied by `lunora/flags.ts` when it
     * uses the Flagship provider in binding mode — `undefined` for HTTP-mode
     * Flagship, a custom OpenFeature provider, or no flags. The binding needs an
     * un-mintable `app_id`, so it is reconciled as a hint, not auto-written.
     */
    flagshipBinding?: string;

    /**
     * The schema's `.jurisdiction("…")`, when it declares one. Read by the binding
     * hints whose resource takes its residency at creation (Artifacts), so the
     * hint can name the jurisdiction to create it in.
     */
    jurisdiction?: SchemaInfo["jurisdiction"];
    /** Schema declares a `.global()` table → needs the `DB` D1 binding. */
    needsD1: boolean;
    /** Queues declared in `lunora/queues.ts` → reconciled into `queues.producers[]` / `queues.consumers[]`. */
    queues: InferredQueue[];

    /**
     * Sibling Workers declared in `lunora.config` `services` → reconciled into
     * `services[]` (plan 457). `undefined` when the declaration is unreadable, so
     * reconcile leaves every entry alone rather than removing the owned ones.
     */
    services: ServiceBindingIR[] | undefined;
    /** Human-readable provenance for each inferred binding / hint, for logging. */
    signals: string[];
    /** `@lunora/ai` is imported, `ctx.ai` read, or `env.AI` used → needs the `ai` Workers AI binding. */
    usesAi: boolean;
    /** `ctx.aiSearch` is used → self-describing `ai_search_namespaces` binding (`AI_SEARCH` on namespace `default`; auto-writeable). */
    usesAiSearch: boolean;
    /** `@lunora/bindings/analytics` is imported or `ctx.analytics` read → self-describing `analytics_engine_datasets` binding (auto-writeable). */
    usesAnalytics: boolean;
    /** `ctx.analyticsSql` is used → self-describing `analytics` binding (`{ binding: ANALYTICS_SQL }`; auto-writeable, wrangler >= 4.145.0). */
    usesAnalyticsSql: boolean;

    /**
     * `ctx.artifacts` is read or `@lunora/bindings/artifacts` value-imported.
     * Hint-only: the first repo `create()` against a missing namespace creates it
     * UNRESTRICTED, and a namespace's jurisdiction can never change after that,
     * so Lunora never writes the binding for you.
     */
    usesArtifacts: boolean;
    /** `@lunora/auth` is imported (sessions may be D1- or `SessionDO`-backed). */
    usesAuth: boolean;
    /** `@lunora/browser` is imported or `ctx.browser` read → self-describing `browser` binding (auto-writeable). */
    usesBrowser: boolean;
    /** `@lunora/auth/cimd/workers` is imported → needs the `global_fetch_strictly_public` compatibility flag (no binding; `lunora doctor` checks it). */
    usesCimdWorkers: boolean;
    /** `lunora/flags.ts` declares a feature-flag provider (any OpenFeature provider — Flagship or custom). */
    usesFlags: boolean;
    /** `@lunora/hyperdrive` is imported or `ctx.sql` read (binding needs an un-mintable remote `id`; hint-only). */
    usesHyperdrive: boolean;
    /** `@lunora/bindings/images` is imported or `ctx.images` read → self-describing `images` binding (auto-writeable). */
    usesImages: boolean;
    /** `@lunora/bindings/kv` is imported or `ctx.kv` read (namespace binding name + id are user-defined; hint-only). */
    usesKv: boolean;
    /** `@lunora/mail` is imported (Resend API key must be set in `.dev.vars`; no binding). */
    usesMail: boolean;
    /** `@lunora/notify` is imported (Web Push needs VAPID/FCM secrets in `.dev.vars`; no binding). */
    usesNotify: boolean;
    /** `@lunora/payment` is imported (provider secrets must be set in `.dev.vars`; no binding). */
    usesPayment: boolean;
    /** `ctx.pipelines` is used (binding needs an un-mintable remote pipeline name; hint-only). */
    usesPipelines: boolean;
    /** `ctx.r2sql` is used (needs the `R2_SQL_*` secrets in `.dev.vars`; no binding). */
    usesR2sql: boolean;
    /** `@lunora/scheduler` is imported. */
    usesScheduler: boolean;
    /** `@lunora/storage` is imported (R2 bucket binding name is user-defined). */
    usesStorage: boolean;
    /** `jsCodeTool` is imported from `@lunora/agent` in `lunora/` → self-describing `worker_loaders` binding (`LOADER`). */
    usesWorkerLoader: boolean;
    /** `@lunora/x402/charge` is imported — the charge rail settles USDC to a recipient address (a public `[vars]` entry, user-named; hint-only). */
    usesX402Charge: boolean;
    /** `@lunora/x402/pay` is imported — the agent-wallet pay rail signs from a Secrets Store binding paired with a spend policy (ActionCtx-only; hint-only). */
    usesX402Pay: boolean;
    /** Workflows declared in `lunora/workflows.ts` (exported or not — see {@link InferredWorkflow.exported}). */
    workflows: InferredWorkflow[];
}

/**
 * Which capabilities a unit of source imports. Pure value, no mutation. The
 * import-driven flags are {@link CAPABILITY_SOURCES}'s keys; `needsD1` is the
 * one capability not driven by an import (it comes from `env.DB` / a `.global()`
 * schema), so it is added explicitly.
 */
type Capabilities = Record<CapabilityFlag | "needsD1" | "usesWorkerLoader", boolean>;

/** Every capability key, including the non-import-driven `needsD1`. */
const ALL_CAPABILITY_KEYS: ReadonlyArray<keyof Capabilities> = [...CAPABILITY_FLAGS, "needsD1", "usesWorkerLoader"];

/** Build a fresh all-`false` capability set keyed by {@link ALL_CAPABILITY_KEYS}. */
const emptyCapabilities = (): Capabilities => {
    const base = {} as Capabilities;

    for (const key of ALL_CAPABILITY_KEYS) {
        base[key] = false;
    }

    return base;
};

const NO_CAPABILITIES: Capabilities = Object.freeze(emptyCapabilities());

const mergeCapabilities = (a: Capabilities, b: Capabilities): Capabilities => {
    const merged = {} as Capabilities;

    for (const key of ALL_CAPABILITY_KEYS) {
        merged[key] = a[key] || b[key];
    }

    return merged;
};

/** A dynamic `import("…")` with a literal specifier — the regex fallback for a file `es-module-lexer` rejects. */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu;

/** What `es-module-lexer` sees of a file's imports: the static specifiers (the parse prefilter) and the dynamic ones. */
interface LexedImports {
    dynamicImports: ReadonlySet<string>;
    staticImports: ReadonlySet<string>;
}

/** Lex a file's imports, or `undefined` when `es-module-lexer` cannot parse it (a mid-edit file, TS-only syntax). */
const lexImports = (code: string): LexedImports | undefined => {
    let imports: ReturnType<typeof lexModule>[0];

    try {
        [imports] = lexModule(code);
    } catch {
        return undefined;
    }

    const dynamicImports = new Set<string>();
    const staticImports = new Set<string>();

    for (const entry of imports) {
        if (entry.n !== undefined) {
            // `d` is -1 for a static import, > -1 for a dynamic `import()`.
            (entry.d === -1 ? staticImports : dynamicImports).add(entry.n);
        }
    }

    return { dynamicImports, staticImports };
};

/** Creates the in-memory project a scan parses its files into — one per {@link inferLunoraBindings} run, built on first use. */
type ScanProject = () => Project;

const createScanProject = (): ScanProject => {
    let project: Project | undefined;

    return () => {
        project ??= new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });

        return project;
    };
};

const NO_SIGNALS: SourceCapabilitySignals = { contextReads: new Set(), valueImports: new Set() };

/**
 * The value imports and `ctx.<property>` reads of one file, read by
 * `@lunora/codegen`'s own per-file probe ({@link sourceCapabilitySignals}) over a parsed AST — so a
 * type-only import, or a `ctx.kv` inside a comment or a string, implies nothing
 * here exactly as it implies nothing to codegen, while a destructured
 * `const { r2sql } = ctx` or a renamed context does. The lexer is only the cheap
 * prefilter: a file importing none of the capability packages and naming no
 * helper off `ctx` is never parsed. A file the lexer rejects is parsed anyway
 * (the TypeScript parser recovers from a mid-edit error). `fileName` picks the
 * parser's script kind (`.tsx` / `.jsx` vs `.ts` / `.js`); `readsContext` says
 * whether the file's `ctx` reads count (see {@link scanCapabilities}).
 */
const readSourceSignals = (
    code: string,
    fileName: string,
    lexed: LexedImports | undefined,
    readsContext: boolean,
    scanProject: ScanProject,
): SourceCapabilitySignals => {
    const worthParsing =
        lexed === undefined ||
        [...lexed.staticImports].some((specifier) => CAPABILITY_PACKAGES.has(specifier)) ||
        (readsContext && CONTEXT_PATTERN.test(code) && CONTEXT_PROPERTY_PATTERN.test(code));

    if (!worthParsing) {
        return NO_SIGNALS;
    }

    const project = scanProject();
    const sourceFile = project.createSourceFile(`/scan/${fileName.slice(fileName.lastIndexOf("/") + 1)}`, code, { overwrite: true });
    const signals = sourceCapabilitySignals(sourceFile);

    project.removeSourceFile(sourceFile);

    return signals;
};

/** Detect, for a single source file (`fileName` only picks the parser), which Lunora capabilities it pulls in. */
const capabilitiesFromSource = (code: string, fileName: string, readsContext: boolean, scanProject: ScanProject): Capabilities => {
    const lexed = lexImports(code);
    const { contextReads, valueImports } = readSourceSignals(code, fileName, lexed, readsContext, scanProject);
    const dynamicImports = lexed?.dynamicImports ?? new Set([...code.matchAll(DYNAMIC_IMPORT_PATTERN)].map((match) => match[1] as string));
    // NOTE: `usesBrowser`'s sandbox-`browserTool` half is intentionally NOT
    // folded in here — see `scanSandboxToolUsage` below. Unlike every
    // other probe, it must be scoped to EXACTLY the `lunora/` file set
    // `discover/sandbox.ts` scans (never `src/`), so it runs as a separate,
    // lunora-only pass in `inferLunoraBindings` instead.
    const capabilities: Capabilities = { ...NO_CAPABILITIES, needsD1: ENV_DB_PATTERN.test(code) };

    for (const flag of CAPABILITY_FLAGS) {
        const { contextProperty, dynamicImport, source } = CAPABILITY_SOURCES[flag];

        capabilities[flag] =
            valueImports.has(source) ||
            (readsContext && contextProperty !== undefined && contextReads.has(contextProperty)) ||
            (dynamicImport && dynamicImports.has(source));
    }

    capabilities.usesAi ||= ENV_AI_PATTERN.test(code);

    return capabilities;
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
    /** Directories (relative to root) to scan. Defaults to `lunora` + `src`. */
    scanDirs?: ReadonlyArray<string>;
    /** Lunora source directory holding `schema.ts`. Defaults to `lunora`. */
    schemaDir?: string;
}

/** The schema facts binding inference reads. */
interface SchemaFacts {
    /** The schema's `.jurisdiction("…")`, for the creation-time hints. */
    jurisdiction: SchemaInfo["jurisdiction"];
    /** A `.global()` table needs the `DB` D1 binding. */
    needsD1: boolean;
}

/**
 * The schema-derived signals. Delegates to the shared `discoverSchemaInfo` so
 * inference and the wrangler validator read the exact same facts. A missing or
 * unparseable schema yields no D1 need and no jurisdiction — codegen surfaces the
 * actionable error elsewhere.
 */
const schemaFacts = (projectRoot: string, schemaDirectory: string): SchemaFacts => {
    const { info } = discoverSchemaInfo(projectRoot, schemaDirectory);

    return { jurisdiction: info?.jurisdiction, needsD1: info?.hasD1GlobalTable ?? false };
};

/**
 * Union the capabilities imported across every scanned source file. A
 * `ctx.<property>` read counts only under `lunoraDirectory`: that is the file set
 * codegen probes, so it is the only place a read gets the helper wired — and a
 * hand-written Durable Object in `src/` reading its own `ctx.storage` (the
 * `DurableObjectState`) must not hint an R2 bucket.
 */
const scanCapabilities = (projectRoot: string, scanDirectories: ReadonlyArray<string>, lunoraDirectory: string): Capabilities => {
    const scanProject = createScanProject();
    const lunoraPrefix = `${join(projectRoot, lunoraDirectory)}/`;
    let merged = NO_CAPABILITIES;

    for (const relativeDirectory of scanDirectories) {
        const absolute = join(projectRoot, relativeDirectory);

        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            continue;
        }

        const files: string[] = [];

        collectSourceFiles(absolute, files);

        for (const file of files) {
            merged = mergeCapabilities(merged, capabilitiesFromSource(readFileSync(file, "utf8"), file, file.startsWith(lunoraPrefix), scanProject));
        }
    }

    return merged;
};

/**
 * Scan ONLY the `lunora/` tree (never `src/`) for value imports of the sandbox
 * tools — mirrors `discover/sandbox.ts`'s `listLunoraSourceFiles` file set
 * exactly. Kept as a separate pass from {@link scanCapabilities} (which also
 * walks `src/`) so config never auto-writes a binding codegen will never wire:
 * a `src/`-only `browserTool` import never registers the `sandbox:invoke`
 * dispatcher, and a `src/`-only `jsCodeTool` never reaches the
 * `workerLoaders` gate, since `discoverSandboxUsage` only reads `lunora/`.
 */
const scanSandboxToolUsage = (projectRoot: string, lunoraDirectory: string): Record<SandboxToolName, boolean> => {
    const absolute = join(projectRoot, lunoraDirectory);
    const found = Object.fromEntries(SANDBOX_TOOLS.map((tool) => [tool, false])) as Record<SandboxToolName, boolean>;

    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        return found;
    }

    const files: string[] = [];

    collectSourceFiles(absolute, files);

    for (const file of files) {
        const imported = sandboxToolImports(readFileSync(file, "utf8"));

        for (const tool of SANDBOX_TOOLS) {
            found[tool] ||= imported[tool];
        }
    }

    return found;
};

/** Provenance lines for declared DO containers / workflows / agents. */
const describeDeclaredExports = (
    containers: ReadonlyArray<InferredContainer>,
    workflows: ReadonlyArray<InferredWorkflow>,
    agents: ReadonlyArray<InferredAgent>,
): string[] => [
    ...containers.map((container) =>
        container.exported
            ? `${container.bindingName}/${container.className} (container "${container.exportName}" declared and exported)`
            : `hint: container "${container.exportName}" is declared but ${container.className} is not exported by the worker entry — add \`export * from "./lunora/_generated/containers"\``,
    ),
    ...workflows.map((workflow) =>
        workflow.exported
            ? `exports.${workflow.className} (workflow "${workflow.exportName}" declared and exported)`
            : `hint: workflow "${workflow.exportName}" is declared but ${workflow.className} is not exported by the worker entry — add \`export * from "./lunora/_generated/workflows"\``,
    ),
    ...agents.map((agent) =>
        agent.exported
            ? `exports.${agent.className} (agent "${agent.exportName}" declared and exported)`
            : `hint: agent "${agent.exportName}" is declared but ${agent.className} is not exported by the worker entry — add \`export * from "./lunora/_generated/agents"\``,
    ),
];

/**
 * Provenance lines implied by capability imports. Each entry is a predicate on
 * the scanned capabilities plus the signal it contributes when true; `schema`
 * supplies the facts a hint needs to name where to create a resource.
 */
const describeCapabilitySignals = (capabilities: Capabilities, exported: ReadonlySet<string>, schema: SchemaFacts): string[] => {
    const rules: ReadonlyArray<[boolean, string]> = [
        [capabilities.usesAi, "AI (@lunora/ai imported, ctx.ai read or env.AI used)"],
        [
            capabilities.usesAuth && !exported.has("SessionDO"),
            "hint: @lunora/auth is imported; its tables are D1-backed by default. For DO-backed auth (what @better-auth/scim needs), pass `namespace` to .auth() and export the generated auth DO class",
        ],
        [capabilities.usesScheduler && !exported.has("SchedulerDO"), "hint: @lunora/scheduler is imported but no SchedulerDO is exported by the worker entry"],
        [capabilities.usesStorage, "hint: @lunora/storage is imported; add an r2_buckets binding (bucket binding names are user-defined)"],
        [capabilities.usesMail, "hint: @lunora/mail is imported; set RESEND_API_KEY in .dev.vars (obtain at https://resend.com/api-keys)"],
        [capabilities.usesPayment, `hint: @lunora/payment is imported; set the provider secrets in .dev.vars — ${PAYMENT_PROVIDER_SECRETS}`],
        // Self-describing bindings: the binding name is the whole config (no remote
        // id to mint), so reconcile auto-writes them like the DO/D1 bindings.
        [capabilities.usesBrowser, "browser (@lunora/browser imported or ctx.browser read) — self-describing { binding: BROWSER }"],
        [capabilities.usesImages, "images (@lunora/bindings/images imported or ctx.images read) — self-describing { binding: IMAGES }"],
        [
            capabilities.usesAnalytics,
            "analytics_engine_datasets (@lunora/bindings/analytics imported or ctx.analytics read) — self-describing { binding: ANALYTICS, dataset }",
        ],
        [capabilities.usesWorkerLoader, "worker_loaders (jsCodeTool imported in lunora/) — self-describing { binding: LOADER }"],
        [
            capabilities.usesAiSearch,
            'ai_search_namespaces (ctx.aiSearch used) — self-describing { binding: AI_SEARCH, namespace: "default" }; remote-only, so `lunora dev` reaches the deployed AI Search service',
        ],
        [
            capabilities.usesAnalyticsSql,
            "analytics (ctx.analyticsSql used) — self-describing { binding: ANALYTICS_SQL }; needs wrangler >= 4.145.0, and is remote-only, so `lunora dev` queries the account's live analytics",
        ],
        // Hint bindings: each needs a remote resource Lunora can't fabricate (a KV
        // namespace id, a Hyperdrive id, a Pipelines pipeline name), so they surface
        // as hints — never an auto-write — exactly like R2's user-defined bucket name.
        [
            capabilities.usesKv,
            "hint: @lunora/bindings/kv is imported or ctx.kv is read; add a kv_namespaces binding ({ binding, id }) and pass env.<BINDING> to createKv() — the namespace id can't be auto-provisioned",
        ],
        [
            capabilities.usesHyperdrive,
            "hint: @lunora/hyperdrive is imported or ctx.sql is read; run 'wrangler hyperdrive create' and add a 'hyperdrive' binding ({ binding, id }) — the id can't be auto-provisioned",
        ],
        [
            capabilities.usesPipelines,
            "hint: ctx.pipelines is used; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, stream }) — the pipeline resource can't be auto-provisioned",
        ],
        [capabilities.usesArtifacts, `hint: ${artifactsBindingHint(schema.jurisdiction)}`],
        [
            capabilities.usesX402Charge,
            "hint: @lunora/x402/charge is imported; set the recipient wallet address as a [vars] entry (the var name is yours to choose) and pass it to the charge config — the x402 facilitator settles USDC to that address",
        ],
        [
            capabilities.usesX402Pay,
            "hint: @lunora/x402/pay is imported (ActionCtx-only, spends real funds); add a secrets_store_secrets[] binding for the agent wallet key (name it to match signer.secretName) and pair the pay rail with a spend policy — ctx.secrets reads a Secrets Store binding, not .dev.vars, so the key can't be auto-provisioned",
        ],
    ];

    return rules.filter(([active]) => active).map(([, signal]) => signal);
};

/** Build the human-readable provenance list. */
const describeSignals = (
    durableObjects: DurableObjectSpec[],
    schema: SchemaFacts,
    capabilities: Capabilities,
    containers: ReadonlyArray<InferredContainer> = [],
    workflows: ReadonlyArray<InferredWorkflow> = [],
    agents: ReadonlyArray<InferredAgent> = [],
): string[] => {
    const exported = new Set(durableObjects.map((object) => object.className));
    const signals = durableObjects.map((object) => `${object.binding}/${object.className} (exported by worker entry)`);

    if (schema.needsD1) {
        signals.push("DB (.global() table declared)");
    }

    signals.push(...describeDeclaredExports(containers, workflows, agents), ...describeCapabilitySignals(capabilities, exported, schema));

    return signals;
};

/**
 * Scan a Lunora project and report which Cloudflare bindings its code implies.
 * Read-only: performs no writes. Binding provisioning is driven by the worker
 * entry's Durable Object exports plus the schema's D1 need; capability imports
 * surface as hints.
 */
const inferLunoraBindings = async (options: InferOptions): Promise<InferredBindings> => {
    await initLexer;

    const schemaDirectory = options.schemaDir ?? "lunora";
    const scanDirectories = options.scanDirs ?? DEFAULT_SCAN_DIRECTORIES;

    const scannedCapabilities = scanCapabilities(options.projectRoot, scanDirectories, schemaDirectory);
    // A sandbox `browserTool` import provisions BROWSER even without a direct
    // `@lunora/browser` import (the browser op runs on the dispatcher's ctx) —
    // but ONLY when the import lives in `lunora/`, the exact file set
    // `discover/sandbox.ts` scans; a `src/`-only import never registers the
    // sandbox dispatcher, so it must not provision the binding either. Folded
    // into `capabilities` here (not `scanCapabilities`) so both the returned
    // `usesBrowser` flag AND the provenance signal line agree.
    const sandboxTools = scanSandboxToolUsage(options.projectRoot, schemaDirectory);
    const capabilities: Capabilities = {
        ...scannedCapabilities,
        usesBrowser: scannedCapabilities.usesBrowser || sandboxTools.browserTool,
        usesWorkerLoader: sandboxTools.jsCodeTool,
    };
    const entry = resolveWorkerEntry(options.projectRoot);
    let durableObjects: DurableObjectSpec[];

    if (entry.composed) {
        // Plus `SchedulerDO` / `ShardRegistryDO` when codegen wrote the module
        // that forwards it: the composed entry star-re-exports it, so the class
        // IS exported and the binding is provisionable. Reading only the base list above left
        // `reconcile-bindings` telling a correctly-wired class-A app to
        // "export it so the SCHEDULER binding can be provisioned" — advice that is
        // both wrong and impossible to follow, on every `lunora dev`.
        const composedClasses: DurableObjectClass[] = [
            ...COMPOSED_ENTRY_DURABLE_OBJECTS,
            ...Object.entries(GENERATED_MODULE_DURABLE_OBJECTS)
                .filter(([module]) => existsSync(join(options.projectRoot, schemaDirectory, GENERATED_DIRECTORY, `${module}.ts`)))
                .map(([, className]) => className),
        ];

        durableObjects = composedClasses.map((className) => {
            return { binding: DURABLE_OBJECT_BINDINGS[className], className };
        });
    } else {
        durableObjects = entry.path === undefined ? [] : detectExportedDurableObjects(entry.path);
    }

    const discoveredSchema = schemaFacts(options.projectRoot, schemaDirectory);
    const schema: SchemaFacts = { ...discoveredSchema, needsD1: capabilities.needsD1 || discoveredSchema.needsD1 };
    const containers = detectClassExports(entry, discoverContainerInfo(options.projectRoot, schemaDirectory).containers, "containers");
    const workflows = detectClassExports(entry, discoverWorkflowInfo(options.projectRoot, schemaDirectory).workflows, "workflows");
    // Agents compile onto Cloudflare Workflows, so — like workflows — only an
    // exported agent WorkflowEntrypoint class is safe to reconcile into `exports`.
    const agents = detectClassExports(entry, discoverAgentInfo(options.projectRoot, schemaDirectory).agents, "agents");
    // Queues need no worker-entry export (their `queue()` handler rides
    // `createWorker`), so the discovered list is reconcilable as-is.
    const queues = [...discoverQueueInfo(options.projectRoot, schemaDirectory).queues];
    // Feature flags are declared in `lunora/flags.ts` (any OpenFeature provider).
    // Only a Flagship binding-mode provider implies a wrangler `flagship` binding
    // (its `app_id` is un-mintable → reconciled as a hint, never auto-written).
    const { flags } = discoverFlagsInfo(options.projectRoot, schemaDirectory);
    const flagshipBinding = flags?.provider === "flagship" && flags.mode === "binding" ? flags.bindingName : undefined;

    // The import-driven `uses*` flags are projected straight off the scanned
    // capabilities (keyed by CAPABILITY_SOURCES); `needsD1` is overridden with
    // the schema-augmented value computed above rather than the raw import flag.
    const capabilityFlags = {} as Pick<InferredBindings, CapabilityFlag>;

    for (const flag of CAPABILITY_FLAGS) {
        capabilityFlags[flag] = capabilities[flag];
    }

    const signals = describeSignals(durableObjects, schema, capabilities, containers, workflows, agents);

    if (flagshipBinding !== undefined) {
        signals.push(
            `hint: lunora/flags.ts uses Flagship in binding mode; add a flagship binding ({ binding: "${flagshipBinding}", app_id }) — the app_id can't be auto-provisioned`,
        );
    }

    // Codegen throws, naming the entry, on a declaration it cannot wire; that
    // error surfaces there, so inference only reconciles what resolves.
    const resolved = readServiceBindings(options.projectRoot);
    const services = resolved.error === undefined ? resolved.services : undefined;

    if (resolved.error !== undefined) {
        signals.push(`hint: lunora.config \`services\` not reconciled — ${resolved.error}`);
    }

    signals.push(...resolved.services.map((service) => `${service.binding} → ${service.worker} (lunora.config services.${service.name})`));

    return {
        agents,
        containers,
        durableObjects,
        flagshipBinding,
        ...(schema.jurisdiction === undefined ? {} : { jurisdiction: schema.jurisdiction }),
        needsD1: schema.needsD1,
        queues,
        services,
        signals,
        usesFlags: flags !== undefined,
        usesWorkerLoader: capabilities.usesWorkerLoader,
        workflows,
        ...capabilityFlags,
    };
};

/**
 * Derive the list of `@lunora/*` package names that are actively used by a
 * project, based on its already-resolved {@link InferredBindings}.
 *
 * This is the canonical bridge between binding inference and the package-aware
 * `.dev.vars.example` scaffolding in `scaffold-dev-variables.ts`. The result is
 * a stable, predictable slice of {@link CAPABILITY_SOURCES} source values,
 * filtered to the flags that are `true` in `bindings` — in flag-name order.
 */
const packageNamesFromBindings = (bindings: InferredBindings): string[] => {
    const names: string[] = [];

    for (const flag of CAPABILITY_FLAGS) {
        if (bindings[flag]) {
            names.push(CAPABILITY_SOURCES[flag].source);
        }
    }

    return names;
};

export type { InferOptions, InferredAgent, InferredBindings, InferredContainer, InferredQueue, InferredWorkflow };
export { inferLunoraBindings, packageNamesFromBindings };
