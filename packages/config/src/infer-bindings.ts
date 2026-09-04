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
import { readWranglerJsonc, WRANGLER_FILES } from "./cloudflare/wrangler-path";
import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import { escapeRegExp } from "./dev-variables-format";
import { discoverFlagsInfo } from "./flags-info";
import join from "./path";
import type { QueueIR } from "./queue-info";
import { discoverQueueInfo } from "./queue-info";
import { discoverSchemaInfo } from "./schema-info";
import type { WorkflowIR } from "./workflow-info";
import { discoverWorkflowInfo } from "./workflow-info";

/** Source file extensions worth scanning for capability signals. */
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/** Directories never worth descending into during a capability scan. */
const IGNORED_DIRECTORIES = new Set([".git", ".lunora-cache", ".wrangler", "_generated", "dist", "node_modules"]);

/** Directories scanned for capability signals when the caller does not override. */
const DEFAULT_SCAN_DIRECTORIES = ["lunora", "src"] as const;

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
// Pipelines ships from `@lunora/bindings/pipelines` but is codegen-wired onto
// ActionCtx, so apps reach it via `ctx.pipelines` rather than importing the
// subpath — and a plain `@lunora/bindings/analytics` import must NOT flip the
// pipelines binding hint. So detect the `ctx.pipelines` access directly,
// mirroring the codegen feature probe.
const CTX_PIPELINES_PATTERN = /\bctx\s*\.\s*pipelines\b/;
const TYPE_ONLY_IMPORT_PATTERN = /^\s*import\s+type\b/;

/**
 * The specifiers the batteries-included `browserTool` sandbox detector treats
 * as `@lunora/agent` — mirrors `discover/sandbox.ts`'s identical constant
 * exactly (both the main entry and the `/sandbox` subpath re-export the tool).
 */
const SANDBOX_MODULE_SPECIFIERS = new Set(["@lunora/agent", "@lunora/agent/sandbox"]);

/**
 * Extracts the specifier list between the FIRST `{` and its matching `}` in
 * an import declaration's sliced text via plain index scans (not a regex),
 * so the two capability checks below each scan that single bounded slice
 * once instead of two overlapping `[^}]*` quantifiers around a shared
 * anchor — the super-linear-backtracking shape `sonarjs/slow-regex` flags.
 */
const extractImportSpecifierList = (statementText: string): string => {
    const openBraceIndex = statementText.indexOf("{");

    if (openBraceIndex === -1) {
        return "";
    }

    const closeBraceIndex = statementText.indexOf("}", openBraceIndex + 1);

    return closeBraceIndex === -1 ? statementText.slice(openBraceIndex + 1) : statementText.slice(openBraceIndex + 1, closeBraceIndex);
};

/**
 * A specifier-level `{ type browserTool }` inside an otherwise-value import —
 * compiles away even though the import declaration itself is a value import
 * (e.g. alongside `containerTool`). Mirrors `discover/sandbox.ts`'s
 * `named.isTypeOnly()` guard. Tested against the extracted specifier list, not
 * the whole statement.
 */
const TYPE_BROWSER_TOOL_SPECIFIER_PATTERN = /\btype\s+browserTool\b/;

/** A named `browserTool` specifier appears in the extracted specifier list. */
const BROWSER_TOOL_NAME_PATTERN = /\bbrowserTool\b/;

/**
 * Whole-file regex fallback for `hasSandboxBrowserToolImport`, used ONLY when
 * `es-module-lexer` can't parse the file (e.g. mid-edit) — same
 * degrade-gracefully contract as `capabilitiesFromSource`'s
 * `lexCapabilities`/`regexCapabilities` split. Being a blind text sweep, it
 * shares the same comment-blindness every other capability's regex fallback
 * already has; the primary (lexer-based) path below does not.
 */
const SANDBOX_BROWSER_TOOL_FALLBACK_PATTERN = /import\s+\{[^}]*\bbrowserTool\b[^}]*\}\s+from\s+["']@lunora\/agent(?:\/sandbox)?["']/;

/**
 * True when the sliced text of a SINGLE import declaration is a VALUE
 * (non-type-only) named import of `browserTool` — mirrors
 * `discover/sandbox.ts`'s `declaration.isTypeOnly()` (whole import) and
 * `named.isTypeOnly()` (single specifier) guards exactly.
 */
const isValueBrowserToolImport = (statementText: string): boolean => {
    if (TYPE_ONLY_IMPORT_PATTERN.test(statementText)) {
        return false; // `import type { browserTool } from …` — the whole import compiles away.
    }

    const specifierList = extractImportSpecifierList(statementText);

    return BROWSER_TOOL_NAME_PATTERN.test(specifierList) && !TYPE_BROWSER_TOOL_SPECIFIER_PATTERN.test(specifierList);
};

/**
 * Whether `code` contains a VALUE `browserTool` import from `@lunora/agent`
 * (main entry or `/sandbox`). Unlike the old whole-file regex sweep, this
 * walks `es-module-lexer`'s PARSED import records and tests only the sliced
 * text of each matching declaration — a commented-out import (`// import {
 * browserTool } from "@lunora/agent";`) is never parsed as a declaration at
 * all, so it can never match, and a `type`-prefixed specifier is rejected by
 * {@link isValueBrowserToolImport}. This is what makes the detector agree with
 * `discover/sandbox.ts`'s AST-based one on the same fixture matrix.
 */
const hasSandboxBrowserToolImport = (code: string): boolean => {
    try {
        const [imports] = lexModule(code);

        return imports.some(
            (entry) => entry.n !== undefined && SANDBOX_MODULE_SPECIFIERS.has(entry.n) && isValueBrowserToolImport(code.slice(entry.ss, entry.se)),
        );
    } catch {
        return SANDBOX_BROWSER_TOOL_FALLBACK_PATTERN.test(code);
    }
};

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
    usesPayment: { pattern: /\bfrom\s+["']@lunora\/payment["']/, source: "@lunora/payment" },
    // Keyed off the `ctx.pipelines` access (not an import) — see CTX_PIPELINES_PATTERN.
    // Pipelines is codegen-wired onto ActionCtx, so apps reach it via `ctx.pipelines`
    // rather than importing `@lunora/bindings/pipelines`; `source` names that subpath
    // for the hint message.
    usesPipelines: { pattern: CTX_PIPELINES_PATTERN, source: "@lunora/bindings/pipelines" },
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

/**
 * A `defineAgent` declaration plus whether its generated agent
 * `WorkflowEntrypoint` class (e.g. `SupportAgentWorkflow`) is exported by the
 * worker entry. An agent compiles onto a Cloudflare Workflow, so — exactly like
 * {@link InferredWorkflow} — only exported agents are safe to provision
 * (wrangler rejects a `workflows[].class_name` the worker doesn't export), and
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
    /** Agents declared in `lunora/agents.ts` (exported or not — see {@link InferredAgent.exported}); reconciled into `workflows[]`. */
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
    /** `@lunora/payment` is imported (provider secrets must be set in `.dev.vars`; no binding). */
    usesPayment: boolean;
    /** `ctx.pipelines` is used (binding needs an un-mintable remote pipeline name; hint-only). */
    usesPipelines: boolean;
    /** `@lunora/scheduler` is imported. */
    usesScheduler: boolean;
    /** `@lunora/storage` is imported (R2 bucket binding name is user-defined). */
    usesStorage: boolean;
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
type Capabilities = Record<CapabilityFlag | "needsD1", boolean>;

/** Every capability key, including the non-import-driven `needsD1`. */
const ALL_CAPABILITY_KEYS: ReadonlyArray<keyof Capabilities> = [...CAPABILITY_FLAGS, "needsD1"];

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
    // folded in here — see `scanSandboxBrowserToolUsage` below. Unlike every
    // other probe, it must be scoped to EXACTLY the `lunora/` file set
    // `discover/sandbox.ts` scans (never `src/`), so it runs as a separate,
    // lunora-only pass in `inferLunoraBindings` instead.
    return mergeCapabilities(capabilities, {
        ...NO_CAPABILITIES,
        needsD1: ENV_DB_PATTERN.test(code),
        usesAi: ENV_AI_PATTERN.test(code),
        usesPipelines: CTX_PIPELINES_PATTERN.test(code),
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

/* eslint-disable no-secrets/no-secrets -- false positive: `frameworkComposePlugin` is a function name in prose, not a credential */

/**
 * The virtual module id `@lunora/vite`'s `frameworkComposePlugin` resolves to a
 * COMPOSED class-A worker entry. Every class-A template sets `wrangler.main` to
 * it and ships no entry file at all, so an fs probe can never find one.
 *
 * Duplicated (not imported) from `@lunora/vite`: `@lunora/vite` depends on
 * `@lunora/config`, so importing back would be a cycle. The literal is the
 * public contract a template's `wrangler.jsonc` writes by hand anyway.
 */
const LUNORA_WORKER_VIRTUAL_ID = "virtual:lunora/worker";

/* eslint-enable no-secrets/no-secrets -- re-enable after the LUNORA_WORKER_VIRTUAL_ID doc block */

/**
 * What the project's `wrangler.main` (or the fallback probe) resolves to.
 *
 * `composed` is the class-A case: there is no file to lex, and treating that as
 * "no worker entry" is what made every container/workflow/agent read
 * `exported: false` and get filtered out of reconcile — the app then deployed
 * green and failed at runtime on a missing binding. The composed entry's exports
 * are known statically instead (see {@link COMPOSED_ENTRY_DURABLE_OBJECTS} and
 * `@lunora/vite`'s `GENERATED_CLASS_MODULES`).
 */
interface WorkerEntry {
    /** `true` when `wrangler.main` is `virtual:lunora/worker` — `@lunora/vite` composes the entry. */
    composed: boolean;
    /** Absolute path to a hand-written entry file, or `undefined` for the composed entry / no entry at all. */
    path?: string;
}

/**
 * The Durable Object classes the composed class-A entry exports. It emits
 * exactly one — `export const ShardDO = createShardDO()` — plus star
 * re-exports of the generated container/workflow/agent modules (handled by
 * {@link detectClassExports}). `SchedulerDO`/`SessionDO` are NOT composed in, so
 * they stay unprovisioned, which is honest: binding them would name a class the
 * bundle does not export and `wrangler deploy` would reject it.
 */
const COMPOSED_ENTRY_DURABLE_OBJECTS: DurableObjectClass[] = ["ShardDO"];

/**
 * The class-B composed entry. `lunora deploy` passes this file to wrangler as
 * the positional script whenever it exists, overriding `wrangler.main` — so it
 * is what actually gets bundled and what wrangler checks its DO/Workflow
 * bindings against. `main` in a class-B project names the framework adapter's
 * build output (`.svelte-kit/cloudflare/_worker.js`, `dist/_worker.js`), which
 * exists after `vite build` and exports only the SSR fetch handler. Lexing that
 * instead read every declared class as unexported: nothing provisioned, plus a
 * "add `export * from …`" warning the user cannot silence.
 *
 * Exported, not documented-as-duplicated: the CLI's `resolveComposedWorkerEntry`
 * imports this constant, so the deploy's positional entry and the file this
 * module lexes for exported classes cannot drift apart.
 */
const COMPOSED_WORKER_ENTRY = "src/worker.ts";

/** Read the worker entry from `wrangler.main`, or probe known fallbacks. */
const resolveWorkerEntry = (projectRoot: string): WorkerEntry => {
    for (const candidate of WRANGLER_FILES) {
        const wranglerPath = join(projectRoot, candidate);

        if (!existsSync(wranglerPath)) {
            continue;
        }

        const { parsed } = readWranglerJsonc<{ main?: string }>(wranglerPath);
        const main = parsed?.main;

        // The class-A composed entry: no file exists (nor ever will), and the
        // fallback probe below must NOT run — `src/index.ts` in a class-A app is
        // the client entry, not the worker, so probing it would read the wrong
        // file's exports.
        if (main === LUNORA_WORKER_VIRTUAL_ID) {
            return { composed: true };
        }

        const composedPath = join(projectRoot, COMPOSED_WORKER_ENTRY);

        if (existsSync(composedPath)) {
            return { composed: false, path: composedPath };
        }

        if (typeof main === "string" && existsSync(join(projectRoot, main))) {
            return { composed: false, path: join(projectRoot, main) };
        }

        break;
    }

    for (const fallback of WORKER_ENTRY_FALLBACKS) {
        const fullPath = join(projectRoot, fallback);

        if (existsSync(fullPath)) {
            return { composed: false, path: fullPath };
        }
    }

    return { composed: false };
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

/** A discovered definition whose generated class may or may not be exported by the worker entry. */
interface ClassExportable {
    className: string;
}

/**
 * PRIMARY (lexer-based, per-entry) type-only-export detector. Whether a lexer
 * export entry is the inline `export { type Foo }` (or `export { type Foo as Bar }`)
 * form — the one type-only export shape `es-module-lexer` still lists (it already
 * omits the `export type Foo` declaration and the separate `export type { Foo }`
 * form from its export list). The `type` qualifier sits immediately before the
 * entry's LOCAL name, so we test the source right before `entry.ls` (falling back
 * to `entry.s` when there is no `as` rename). Deciding this PER ENTRY is what keeps
 * a real value export from being suppressed by an unrelated type-only export
 * elsewhere in the entry file.
 *
 * The imprecise whole-file counterpart used only when the lexer can't parse the
 * file is {@link isTypeOnlyExportRegexFallback}.
 */
/** The inline `type` qualifier immediately before an export entry's local name (`export { type Foo }`). Module-scoped so it compiles once, not per export entry. */
const INLINE_TYPE_QUALIFIER = /(?:^|[\s,{])type$/u;

const isTypeOnlyExportEntry = (code: string, entry: { readonly ls: number; readonly s: number }): boolean => {
    const localStart = entry.ls >= 0 ? entry.ls : entry.s;

    return INLINE_TYPE_QUALIFIER.test(code.slice(0, localStart).trimEnd());
};

/**
 * FALLBACK (whole-file regex) type-only-export detector — the imprecise
 * counterpart to {@link isTypeOnlyExportEntry}, used ONLY when `es-module-lexer`
 * cannot parse a mid-edit file. Matches a *type-only* export of `className` —
 * `export type Foo`, the separate `export type { … Foo … }`, or the inline
 * `export { type Foo }`. Generalizes {@link TYPE_ONLY_EXPORT_PATTERNS} (built for
 * the fixed DO class set) to an arbitrary generated class name. The class name is
 * escaped and every pattern carries the `u` flag. The primary (lexer) path decides
 * type-only-ness per export entry instead — this blind whole-file sweep cannot tell
 * which `export` a repeated name came from, so a value + separate type export of
 * the same name still (conservatively) reads type-only here; acceptable for the
 * rare unparseable-file fallback.
 */
const isTypeOnlyExportRegexFallback = (code: string, className: string): boolean => {
    const name = escapeRegExp(className);

    return (
        new RegExp(String.raw`\bexport\s+type\s+${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s+type\s*\{[^}]*\b${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s+\{[^}]*\btype\s+${name}\b`, "u").test(code)
    );
};

/**
 * Whether the worker entry exports each definition's generated class: a named
 * export of the class (covered by `es-module-lexer`'s export list) or the
 * conventional `export * from "./lunora/_generated/<generatedModule>"` star
 * re-export — the way a worker entry re-exports every generated class of one
 * kind at once. `es-module-lexer` lists the module request but not the names a
 * star re-export forwards, so the path itself is the signal that every class
 * from that module is exported.
 *
 * One generic replaces what were three near-identical copies
 * (`detectContainerExports`/`detectWorkflowExports`/`detectAgentExports`,
 * differing only in the star-reexport module name and the IR type) — exports
 * are the only safe provisioning signal for all three kinds, since wrangler
 * validates `class_name` against the worker's exports at deploy. Mirrors the
 * same lexer-then-regex-fallback shape as `detectExportedDurableObjects`.
 */
const detectClassExports = <Definition extends ClassExportable>(
    entry: WorkerEntry,
    definitions: ReadonlyArray<Definition>,
    generatedModule: string,
): (Definition & { exported: boolean })[] => {
    if (definitions.length === 0) {
        return [];
    }

    // The composed class-A entry star-re-exports `_generated/{agents,containers,
    // workflows}` for every kind the project declares (`@lunora/vite`'s
    // `GENERATED_CLASS_MODULES`), so every declaration IS exported. There is no
    // file to lex — reading it as "unexported" is the bug this branch fixes.
    if (entry.composed) {
        return definitions.map((definition) => {
            return { ...definition, exported: true };
        });
    }

    if (entry.path === undefined) {
        return definitions.map((definition) => {
            return { ...definition, exported: false };
        });
    }

    const code = readFileSync(entry.path, "utf8");
    const starReexport = new RegExp(String.raw`\bexport\s*\*\s*from\s*["'][^"']*_generated\/${generatedModule}(?:\.js)?["']`).test(code);

    // The names exported as a runtime VALUE — the only ones safe to bind, since
    // wrangler validates a binding's `class_name` against the worker's exports at
    // deploy. Type-only exports (which compile away) are rejected per entry.
    let valueExportedNames: Set<string>;

    try {
        const [, exports] = lexModule(code);

        // `es-module-lexer` already omits `export type Foo` and the separate
        // `export type { Foo }` from its export list; the one type-only shape it
        // still lists is the inline `export { type Foo }`, dropped here per entry.
        // What remains are the real value exports — so a value `export class Foo {}`
        // is NOT suppressed by an unrelated `export type { Foo }` elsewhere in the
        // entry (the prior unanchored whole-file regex's bug).
        // NB: coupling — `isTypeOnlyExportEntry` reads the source at `exportEntry.ls`/`exportEntry.s`,
        // the byte offsets `es-module-lexer` reports for THIS `code`, so it must be
        // passed the same `code` these `exports` were lexed from.
        valueExportedNames = new Set(exports.filter((exportEntry) => !isTypeOnlyExportEntry(code, exportEntry)).map((exportEntry) => exportEntry.n));
    } catch {
        // Fallback for an unparseable (mid-edit) entry: a blind whole-file sweep for
        // an `export … <className>` that is not a type-only export. Less precise than
        // the lexer path — see the regex-fallback detector called just below.
        valueExportedNames = new Set(
            definitions
                .map((definition) => definition.className)
                .filter(
                    (className) =>
                        new RegExp(String.raw`\bexport\b[^\n;]*\b${escapeRegExp(className)}\b`, "u").test(code) &&
                        !isTypeOnlyExportRegexFallback(code, className),
                ),
        );
    }

    return definitions.map((definition) => {
        const exported = starReexport || valueExportedNames.has(definition.className);

        return { ...definition, exported };
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

/**
 * Scan ONLY the `lunora/` tree (never `src/`) for a value `browserTool`
 * import — mirrors `discover/sandbox.ts`'s `listLunoraSourceFiles` file set
 * exactly. Kept as a separate pass from {@link scanCapabilities} (which also
 * walks `src/`) so config never auto-writes a `BROWSER` binding codegen will
 * never wire — a `src/`-only `browserTool` import never registers the
 * `sandbox:invoke` dispatcher, since `discoverSandboxUsage` only reads
 * `lunora/`.
 */
const scanSandboxBrowserToolUsage = (projectRoot: string, lunoraDirectory: string): boolean => {
    const absolute = join(projectRoot, lunoraDirectory);

    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        return false;
    }

    const files: string[] = [];

    collectSourceFiles(absolute, files);

    return files.some((file) => hasSandboxBrowserToolImport(readFileSync(file, "utf8")));
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
            ? `${workflow.bindingName}/${workflow.className} (workflow "${workflow.exportName}" declared and exported)`
            : `hint: workflow "${workflow.exportName}" is declared but ${workflow.className} is not exported by the worker entry — add \`export * from "./lunora/_generated/workflows"\``,
    ),
    ...agents.map((agent) =>
        agent.exported
            ? `${agent.bindingName}/${agent.className} (agent "${agent.exportName}" declared and exported)`
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
            "hint: ctx.pipelines is used; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, pipeline }) — the pipeline resource can't be auto-provisioned",
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
    const capabilities: Capabilities = {
        ...scannedCapabilities,
        usesBrowser: scannedCapabilities.usesBrowser || scanSandboxBrowserToolUsage(options.projectRoot, schemaDirectory),
    };
    const entry = resolveWorkerEntry(options.projectRoot);
    let durableObjects: DurableObjectSpec[];

    if (entry.composed) {
        durableObjects = COMPOSED_ENTRY_DURABLE_OBJECTS.map((className) => {
            return { binding: DURABLE_OBJECT_BINDINGS[className], className };
        });
    } else {
        durableObjects = entry.path === undefined ? [] : detectExportedDurableObjects(entry.path);
    }

    const needsD1 = capabilities.needsD1 || schemaNeedsD1(options.projectRoot, schemaDirectory);
    const containers = detectClassExports(entry, discoverContainerInfo(options.projectRoot, schemaDirectory).containers, "containers");
    const workflows = detectClassExports(entry, discoverWorkflowInfo(options.projectRoot, schemaDirectory).workflows, "workflows");
    // Agents compile onto Cloudflare Workflows, so — like workflows — only an
    // exported agent WorkflowEntrypoint class is safe to reconcile into `workflows[]`.
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

export type {
    DurableObjectClass,
    DurableObjectSpec,
    InferOptions,
    InferredAgent,
    InferredBindings,
    InferredContainer,
    InferredQueue,
    InferredWorkflow,
    WorkerEntry,
};
// `COMPOSED_WORKER_ENTRY`, `WORKER_ENTRY_FALLBACKS` and `isTypeOnlyExportEntry`
// are shared with the wrangler validator's exported-class check, which answers
// the same question ("which classes does the entry export as runtime values?")
// against the same file. The validator keeps its own path resolver because it
// resolves `main` from the `--env` view relative to the config file, which this
// one (deliberately projectRoot-relative, and reading the top level) does not.
// `resolveWorkerEntry` returns a {@link WorkerEntry}, not a path: the class-A
// composed entry (`main: "virtual:lunora/worker"`) has no file, and reading that
// as "no worker entry" is what left every container/workflow/agent unprovisioned.
export {
    COMPOSED_WORKER_ENTRY,
    inferLunoraBindings,
    isTypeOnlyExportEntry,
    LUNORA_WORKER_VIRTUAL_ID,
    packageNamesFromBindings,
    resolveWorkerEntry,
    WORKER_ENTRY_FALLBACKS,
};
