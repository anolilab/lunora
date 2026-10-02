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

import type { ServiceBindingIR } from "@lunora/codegen";
import { contextPropertiesRead, readServiceBindings } from "@lunora/codegen";
import { init as initLexer, parse as lexModule } from "es-module-lexer";
import { Project } from "ts-morph";

import type { AgentIR } from "./agent-info";
import { discoverAgentInfo } from "./agent-info";
import artifactsBindingHint from "./artifacts-hint";
import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import { discoverFlagsInfo } from "./flags-info";
import type { SandboxToolName } from "./infer-sandbox-tools";
import { extractImportSpecifierList, SANDBOX_TOOLS, sandboxToolImports, TYPE_ONLY_IMPORT_PATTERN } from "./infer-sandbox-tools";
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

/**
 * The single source of truth for import-driven capabilities: each capability
 * flag → the `@lunora/*` package whose import implies it, plus either the regex
 * used by the {@link regexCapabilities} fallback when `es-module-lexer` can't
 * parse a mid-edit file, or — for a **ctx-access** capability — the
 * `contextProperty` whose `ctx.<property>` read implies it (see
 * {@link CTX_ACCESS_CAPABILITIES}). Everything else that enumerates capabilities — the
 * {@link Capabilities} type, {@link NO_CAPABILITIES}, {@link mergeCapabilities},
 * {@link capabilityForImportSource}, {@link regexCapabilities}, and the final
 * {@link InferredBindings} return — is derived from this table, so adding a
 * binding is a one-line entry rather than a seven-site edit.
 */
// Provisioning behaviour per package (see plans 027/028/031/032/035/036):
//   @lunora/bindings/kv         → kv_namespaces             → hint (un-mintable namespace id)
//   @lunora/hyperdrive → hyperdrive                → hint (un-mintable remote id)
//   @lunora/browser    → browser                   → self-describing (binding name only)
//   @lunora/bindings/images     → images                    → self-describing (binding name only)
//   @lunora/bindings/analytics  → analytics_engine_datasets → self-describing (dataset == binding name)
//   ctx.pipelines               → pipelines                 → hint (un-mintable remote pipeline name; ships from @lunora/bindings/pipelines)
//   ctx.artifacts               → artifacts                 → hint (the namespace's jurisdiction is fixed at creation, so never auto-written)
//   ctx.aiSearch                → ai_search_namespaces      → self-describing (namespace "default" always exists; wrangler creates a missing one)
const CAPABILITY_SOURCES = {
    usesAi: { pattern: /\bfrom\s+["']@lunora\/ai["']/, source: "@lunora/ai" },
    // Like `usesPipelines` / `usesR2sql` below: `@lunora/bindings/ai-search` is types
    // only and codegen wires the raw `ai_search_namespaces` binding onto
    // ActionCtx, so the signal is the `ctx.aiSearch` read, never an import.
    usesAiSearch: { contextProperty: "aiSearch", source: "@lunora/bindings/ai-search" },
    usesAnalytics: { pattern: /\bfrom\s+["']@lunora\/bindings\/analytics["']/, source: "@lunora/bindings/analytics" },
    // Artifacts is codegen-wired onto ActionCtx like Pipelines, so an app usually
    // only reads `ctx.artifacts`. A value import of `@lunora/bindings/artifacts`
    // (a hand-built `createArtifacts`) flips it too; a type-only one (`ArtifactsEvent`
    // typing a queue consumer) compiles away and does not — matching codegen.
    usesArtifacts: { contextProperty: "artifacts", source: "@lunora/bindings/artifacts" },
    usesAuth: { pattern: /\bfrom\s+["']@lunora\/auth["']/, source: "@lunora/auth" },
    usesBrowser: { pattern: /\bfrom\s+["']@lunora\/browser["']/, source: "@lunora/browser" },
    usesHyperdrive: { pattern: /\bfrom\s+["']@lunora\/hyperdrive["']/, source: "@lunora/hyperdrive" },
    usesImages: { pattern: /\bfrom\s+["']@lunora\/bindings\/images["']/, source: "@lunora/bindings/images" },
    usesKv: { pattern: /\bfrom\s+["']@lunora\/bindings\/kv["']/, source: "@lunora/bindings/kv" },
    usesMail: { pattern: /\bfrom\s+["']@lunora\/mail["']/, source: "@lunora/mail" },
    // No Cloudflare binding of its own — like `@lunora/mail`, this exists so the
    // package's declared secrets (the VAPID trio + the two FCM keys) reach
    // `.dev.vars.example` and the missing-secret pre-flight. `packageNamesFromBindings`
    // can only emit a source named here, so without this entry those five were
    // declared and consumed by nothing.
    usesNotify: { pattern: /\bfrom\s+["']@lunora\/notify["']/, source: "@lunora/notify" },
    usesPayment: { pattern: /\bfrom\s+["']@lunora\/payment["']/, source: "@lunora/payment" },
    // Pipelines ships from `@lunora/bindings/pipelines` but is codegen-wired onto
    // ActionCtx, so apps reach it via `ctx.pipelines` rather than importing the
    // subpath — and a plain `@lunora/bindings/analytics` import must NOT flip the
    // pipelines binding hint. So the `ctx.pipelines` access is the signal.
    usesPipelines: { contextProperty: "pipelines", source: "@lunora/bindings/pipelines" },
    // R2 SQL is the same shape: codegen-wired onto ActionCtx, reached as
    // `ctx.r2sql`. Its three `R2_SQL_*` secrets had neither a flag nor a registry
    // entry, so `ctx.r2sql` failed silently on the deployed worker.
    usesR2sql: { contextProperty: "r2sql", source: "@lunora/bindings/r2sql" },
    usesScheduler: { pattern: /\bfrom\s+["']@lunora\/scheduler["']/, source: "@lunora/scheduler" },
    usesStorage: { pattern: /\bfrom\s+["']@lunora\/storage["']/, source: "@lunora/storage" },
    // x402 rails are opt-in add-on subpaths (not part of the `lunorash` umbrella),
    // so they key off the exact `@lunora/x402/{charge,pay}` specifiers. Neither
    // implies a `.dev.vars` secret: the charge recipient is a user-named `[vars]`
    // entry and the pay wallet key is a Secrets Store binding — both hint-only.
    usesX402Charge: { pattern: /\bfrom\s+["']@lunora\/x402\/charge["']/, source: "@lunora/x402/charge" },
    usesX402Pay: { pattern: /\bfrom\s+["']@lunora\/x402\/pay["']/, source: "@lunora/x402/pay" },
} as const satisfies Record<string, { contextProperty: string; source: string } | { pattern: RegExp; source: string }>;

/** The import-driven capability flag names (every key of {@link CAPABILITY_SOURCES}). */
type CapabilityFlag = keyof typeof CAPABILITY_SOURCES;

const CAPABILITY_FLAGS = Object.keys(CAPABILITY_SOURCES) as CapabilityFlag[];

/**
 * The **ctx-access** capabilities — the {@link CAPABILITY_SOURCES} rows with a
 * `contextProperty`. Codegen wires each onto `ctx` itself, so an app reaches it
 * as `ctx.<property>` without importing anything; the read is the signal. It is
 * detected with `@lunora/codegen`'s own `contextPropertiesRead` — the AST pass
 * behind codegen's feature probe — so config and codegen agree on every form:
 * a `ctx.<property>` access, a `const { <property> } = ctx` / `({ ctx: { <property> } })`
 * destructuring, a renamed context, and never a comment or a string literal.
 */
const CTX_ACCESS_CAPABILITIES: ReadonlyArray<readonly [CapabilityFlag, string]> = CAPABILITY_FLAGS.flatMap((flag) => {
    const row: { contextProperty?: string; source: string } = CAPABILITY_SOURCES[flag];

    return row.contextProperty === undefined ? [] : [[flag, row.contextProperty] as const];
});

/** Cheap pre-check: only a file naming one of the ctx-access properties is parsed. */
const CTX_ACCESS_PREFILTER = new RegExp(String.raw`\b(?:${CTX_ACCESS_CAPABILITIES.map(([, property]) => property).join("|")})\b`, "u");

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
    /** `@lunora/ai` is imported or `env.AI` is used → needs the `ai` Workers AI binding. */
    usesAi: boolean;
    /** `ctx.aiSearch` is used → self-describing `ai_search_namespaces` binding (`AI_SEARCH` on namespace `default`; auto-writeable). */
    usesAiSearch: boolean;
    /** `@lunora/bindings/analytics` is imported → self-describing `analytics_engine_datasets` binding (auto-writeable). */
    usesAnalytics: boolean;

    /**
     * `ctx.artifacts` is read or `@lunora/bindings/artifacts` value-imported.
     * Hint-only: the first repo `create()` against a missing namespace creates it
     * UNRESTRICTED, and a namespace's jurisdiction can never change after that,
     * so Lunora never writes the binding for you.
     */
    usesArtifacts: boolean;
    /** `@lunora/auth` is imported (sessions may be D1- or `SessionDO`-backed). */
    usesAuth: boolean;
    /** `@lunora/browser` is imported → self-describing `browser` binding (auto-writeable). */
    usesBrowser: boolean;
    /** `lunora/flags.ts` declares a feature-flag provider (any OpenFeature provider — Flagship or custom). */
    usesFlags: boolean;
    /** `@lunora/hyperdrive` is imported (binding needs an un-mintable remote `id`; hint-only). */
    usesHyperdrive: boolean;
    /** `@lunora/bindings/images` is imported → self-describing `images` binding (auto-writeable). */
    usesImages: boolean;
    /** `@lunora/bindings/kv` is imported (namespace binding name + id are user-defined; hint-only). */
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

/** Map a single import source onto the capability it implies. */
const capabilityForImportSource = (source: string): Capabilities => {
    for (const flag of CAPABILITY_FLAGS) {
        if (CAPABILITY_SOURCES[flag].source === source) {
            return { ...NO_CAPABILITIES, [flag]: true };
        }
    }

    return NO_CAPABILITIES;
};

/** An import clause with no default or namespace binding — just `import {`. */
const NAMED_ONLY_IMPORT_HEAD_PATTERN = /^\s*import\s*$/u;

/** A `type`-qualified import specifier (`type Foo`, `type Foo as Bar`). */
const TYPE_SPECIFIER_PATTERN = /^type\s/u;

/**
 * Whether one lexed import statement compiles away: `import type { … } from "…"`,
 * or a named-only import whose every specifier is `type`-qualified
 * (`import { type A, type B } from "…"`). Mirrors codegen's feature probe
 * (`discover/feature-usage.ts`), so a payload type imported from a capability's
 * package wires neither the binding here nor `ctx.<cap>` there.
 */
const isTypeOnlyImportStatement = (statementText: string): boolean => {
    if (TYPE_ONLY_IMPORT_PATTERN.test(statementText)) {
        return true;
    }

    const openBraceIndex = statementText.indexOf("{");

    if (openBraceIndex === -1 || !NAMED_ONLY_IMPORT_HEAD_PATTERN.test(statementText.slice(0, openBraceIndex))) {
        return false;
    }

    const specifiers = extractImportSpecifierList(statementText)
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier.length > 0);

    return specifiers.length > 0 && specifiers.every((specifier) => TYPE_SPECIFIER_PATTERN.test(specifier));
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

        if (!source || isTypeOnlyImportStatement(code.slice(entry.ss, entry.se))) {
            continue;
        }

        capabilities = mergeCapabilities(capabilities, capabilityForImportSource(source));
    }

    return capabilities;
};

/** Regex fallback for when `es-module-lexer` cannot parse a mid-edit file. The ctx-access rows have no pattern: {@link contextAccessCapabilities} covers them either way. */
const regexCapabilities = (code: string): Capabilities => {
    const capabilities = { ...NO_CAPABILITIES };

    for (const flag of CAPABILITY_FLAGS) {
        const row: { pattern?: RegExp; source: string } = CAPABILITY_SOURCES[flag];

        capabilities[flag] = row.pattern?.test(code) ?? false;
    }

    return capabilities;
};

/** The in-memory project the ctx-access pass parses into — created on first use, one file at a time. */
let contextAccessProject: Project | undefined;

/**
 * The {@link CTX_ACCESS_CAPABILITIES} a source file reads off `ctx`, via
 * codegen's own `contextPropertiesRead` over a parsed AST — never a text match,
 * so a `ctx.pipelines` inside a comment or a string implies nothing, while a
 * destructured `const { r2sql } = ctx` does. Only a file that names one of the
 * properties at all is parsed. `fileName` picks the parser's script kind
 * (`.tsx` / `.jsx` vs `.ts` / `.js`).
 */
const contextAccessCapabilities = (code: string, fileName: string): Capabilities => {
    if (!CTX_ACCESS_PREFILTER.test(code)) {
        return NO_CAPABILITIES;
    }

    contextAccessProject ??= new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });

    const sourceFile = contextAccessProject.createSourceFile(`/scan/${fileName.slice(fileName.lastIndexOf("/") + 1)}`, code, { overwrite: true });
    const read = contextPropertiesRead(sourceFile);

    contextAccessProject.removeSourceFile(sourceFile);

    const capabilities = { ...NO_CAPABILITIES };

    for (const [flag, property] of CTX_ACCESS_CAPABILITIES) {
        capabilities[flag] = read.has(property);
    }

    return capabilities;
};

/** Detect, for a single source file (`fileName` only picks the parser), which Lunora capabilities it pulls in. */
const capabilitiesFromSource = (code: string, fileName: string): Capabilities => {
    let capabilities: Capabilities;

    try {
        capabilities = lexCapabilities(code);
    } catch {
        capabilities = regexCapabilities(code);
    }

    // NOTE: `usesBrowser`'s sandbox-`browserTool` half is intentionally NOT
    // folded in here — see `scanSandboxToolUsage` below. Unlike every
    // other probe, it must be scoped to EXACTLY the `lunora/` file set
    // `discover/sandbox.ts` scans (never `src/`), so it runs as a separate,
    // lunora-only pass in `inferLunoraBindings` instead.
    return mergeCapabilities(mergeCapabilities(capabilities, contextAccessCapabilities(code, fileName)), {
        ...NO_CAPABILITIES,
        needsD1: ENV_DB_PATTERN.test(code),
        usesAi: ENV_AI_PATTERN.test(code),
    });
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
            merged = mergeCapabilities(merged, capabilitiesFromSource(readFileSync(file, "utf8"), file));
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
        [capabilities.usesAi, "AI (@lunora/ai imported or env.AI used)"],
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
        [capabilities.usesBrowser, "browser (@lunora/browser imported) — self-describing { binding: BROWSER }"],
        [capabilities.usesImages, "images (@lunora/bindings/images imported) — self-describing { binding: IMAGES }"],
        [capabilities.usesAnalytics, "analytics_engine_datasets (@lunora/bindings/analytics imported) — self-describing { binding: ANALYTICS, dataset }"],
        [capabilities.usesWorkerLoader, "worker_loaders (jsCodeTool imported in lunora/) — self-describing { binding: LOADER }"],
        [
            capabilities.usesAiSearch,
            'ai_search_namespaces (ctx.aiSearch used) — self-describing { binding: AI_SEARCH, namespace: "default" }; remote-only, so `lunora dev` reaches the deployed AI Search service',
        ],
        // Hint bindings: each needs a remote resource Lunora can't fabricate (a KV
        // namespace id, a Hyperdrive id, a Pipelines pipeline name), so they surface
        // as hints — never an auto-write — exactly like R2's user-defined bucket name.
        [
            capabilities.usesKv,
            "hint: @lunora/bindings/kv is imported; add a kv_namespaces binding ({ binding, id }) and pass env.<BINDING> to createKv() — the namespace id can't be auto-provisioned",
        ],
        [
            capabilities.usesHyperdrive,
            "hint: @lunora/hyperdrive is imported; run 'wrangler hyperdrive create' and add a 'hyperdrive' binding ({ binding, id }) — the id can't be auto-provisioned",
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

    const scannedCapabilities = scanCapabilities(options.projectRoot, scanDirectories);
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
 * filtered to the flags that are `true` in `bindings` — in CAPABILITY_SOURCES
 * declaration order.
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
