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

import { init as initLexer, parse as lexModule } from "es-module-lexer";

import type { AgentIR } from "./agent-info";
import { discoverAgentInfo } from "./agent-info";
import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import { discoverFlagsInfo } from "./flags-info";
import type { SandboxToolName } from "./infer-sandbox-tools";
import { SANDBOX_TOOLS, sandboxToolImports, TYPE_ONLY_IMPORT_PATTERN } from "./infer-sandbox-tools";
import join from "./path";
import type { QueueIR } from "./queue-info";
import { discoverQueueInfo } from "./queue-info";
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
// Pipelines ships from `@lunora/bindings/pipelines` but is codegen-wired onto
// ActionCtx, so apps reach it via `ctx.pipelines` rather than importing the
// subpath — and a plain `@lunora/bindings/analytics` import must NOT flip the
// pipelines binding hint. So detect the `ctx.pipelines` access directly,
// mirroring the codegen feature probe.
const CTX_PIPELINES_PATTERN = /\bctx\s*\.\s*pipelines\b/;
// R2 SQL is the same shape as pipelines: `@lunora/bindings/r2sql` is codegen-wired
// onto ActionCtx, so apps reach it as `ctx.r2sql` and never import the subpath.
// Its three `R2_SQL_*` secrets had neither a flag nor a registry entry, so
// `ctx.r2sql` failed silently on the deployed worker.
const CTX_R2SQL_PATTERN = /\bctx\s*\.\s*r2sql\b/;

/**
 * The single source of truth for import-driven capabilities: each capability
 * flag → the `@lunora/*` package whose import implies it, plus the regex used by
 * the {@link regexCapabilities} fallback when `es-module-lexer` can't parse a
 * mid-edit file. Everything else that enumerates capabilities — the
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
const CAPABILITY_SOURCES = {
    usesAi: { pattern: /\bfrom\s+["']@lunora\/ai["']/, source: "@lunora/ai" },
    usesAnalytics: { pattern: /\bfrom\s+["']@lunora\/bindings\/analytics["']/, source: "@lunora/bindings/analytics" },
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
    // Keyed off the `ctx.pipelines` access (not an import) — see CTX_PIPELINES_PATTERN.
    // Pipelines is codegen-wired onto ActionCtx, so apps reach it via `ctx.pipelines`
    // rather than importing `@lunora/bindings/pipelines`; `source` names that subpath
    // for the hint message.
    usesPipelines: { pattern: CTX_PIPELINES_PATTERN, source: "@lunora/bindings/pipelines" },
    // Keyed off the `ctx.r2sql` access, not an import — see CTX_R2SQL_PATTERN.
    usesR2sql: { pattern: CTX_R2SQL_PATTERN, source: "@lunora/bindings/r2sql" },
    usesScheduler: { pattern: /\bfrom\s+["']@lunora\/scheduler["']/, source: "@lunora/scheduler" },
    usesStorage: { pattern: /\bfrom\s+["']@lunora\/storage["']/, source: "@lunora/storage" },
    // x402 rails are opt-in add-on subpaths (not part of the `lunorash` umbrella),
    // so they key off the exact `@lunora/x402/{charge,pay}` specifiers. Neither
    // implies a `.dev.vars` secret: the charge recipient is a user-named `[vars]`
    // entry and the pay wallet key is a Secrets Store binding — both hint-only.
    usesX402Charge: { pattern: /\bfrom\s+["']@lunora\/x402\/charge["']/, source: "@lunora/x402/charge" },
    usesX402Pay: { pattern: /\bfrom\s+["']@lunora\/x402\/pay["']/, source: "@lunora/x402/pay" },
} as const satisfies Record<string, { pattern: RegExp; source: string }>;

/** The import-driven capability flag names (every key of {@link CAPABILITY_SOURCES}). */
type CapabilityFlag = keyof typeof CAPABILITY_SOURCES;

const CAPABILITY_FLAGS = Object.keys(CAPABILITY_SOURCES) as CapabilityFlag[];

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
interface InferredContainer extends ContainerIR {
    exported: boolean;
}

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
    /** Schema declares a `.global()` table → needs the `DB` D1 binding. */
    needsD1: boolean;
    /** Queues declared in `lunora/queues.ts` → reconciled into `queues.producers[]` / `queues.consumers[]`. */
    queues: InferredQueue[];
    /** Human-readable provenance for each inferred binding / hint, for logging. */
    signals: string[];
    /** `@lunora/ai` is imported or `env.AI` is used → needs the `ai` Workers AI binding. */
    usesAi: boolean;
    /** `@lunora/bindings/analytics` is imported → self-describing `analytics_engine_datasets` binding (auto-writeable). */
    usesAnalytics: boolean;
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
    const capabilities = { ...NO_CAPABILITIES };

    for (const flag of CAPABILITY_FLAGS) {
        capabilities[flag] = CAPABILITY_SOURCES[flag].pattern.test(code);
    }

    return capabilities;
};

/** Detect, for a single source file, which Lunora capabilities it pulls in. */
const capabilitiesFromSource = (code: string): Capabilities => {
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
    return mergeCapabilities(capabilities, {
        ...NO_CAPABILITIES,
        needsD1: ENV_DB_PATTERN.test(code),
        usesAi: ENV_AI_PATTERN.test(code),
        usesPipelines: CTX_PIPELINES_PATTERN.test(code),
        usesR2sql: CTX_R2SQL_PATTERN.test(code),
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

/**
 * The schema-derived signal: a `.global()` table needs the `DB` D1 binding.
 * Delegates to the shared `discoverSchemaInfo` so inference and the wrangler
 * validator read the exact same fact. A missing or unparseable schema yields
 * `false` — codegen surfaces the actionable error elsewhere.
 */
const schemaNeedsD1 = (projectRoot: string, schemaDirectory: string): boolean =>
    discoverSchemaInfo(projectRoot, schemaDirectory).info?.hasD1GlobalTable ?? false;

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
 * the scanned capabilities plus the signal it contributes when true.
 */
const describeCapabilitySignals = (capabilities: Capabilities, exported: ReadonlySet<string>): string[] => {
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
    needsD1: boolean,
    capabilities: Capabilities,
    containers: ReadonlyArray<InferredContainer> = [],
    workflows: ReadonlyArray<InferredWorkflow> = [],
    agents: ReadonlyArray<InferredAgent> = [],
): string[] => {
    const exported = new Set(durableObjects.map((object) => object.className));
    const signals = durableObjects.map((object) => `${object.binding}/${object.className} (exported by worker entry)`);

    if (needsD1) {
        signals.push("DB (.global() table declared)");
    }

    signals.push(...describeDeclaredExports(containers, workflows, agents), ...describeCapabilitySignals(capabilities, exported));

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

    const needsD1 = capabilities.needsD1 || schemaNeedsD1(options.projectRoot, schemaDirectory);
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

    const signals = describeSignals(durableObjects, needsD1, capabilities, containers, workflows, agents);

    if (flagshipBinding !== undefined) {
        signals.push(
            `hint: lunora/flags.ts uses Flagship in binding mode; add a flagship binding ({ binding: "${flagshipBinding}", app_id }) — the app_id can't be auto-provisioned`,
        );
    }

    return {
        agents,
        containers,
        durableObjects,
        flagshipBinding,
        needsD1,
        queues,
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
