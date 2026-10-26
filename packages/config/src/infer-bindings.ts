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
import { dirname, resolve } from "node:path";

import type { CapabilityKey, ServiceBindingIR, SourceCapabilitySignals } from "@lunora/codegen";
import {
    capabilitiesUsedBy,
    CAPABILITY_PROBES,
    createTargetScope,
    discoverNotifyChannels,
    foldCapabilitySignals,
    mayReadCapabilityContext,
    NOTIFY_FILENAME,
    readServiceBindings,
    sourceCapabilitySignals,
} from "@lunora/codegen";
// `worker-entry.ts` lexes the entry's exports; the lexer's wasm must be initialised first.
import { init as initLexer } from "es-module-lexer";
import type { BindingElement, CallExpression, Identifier, SourceFile } from "ts-morph";
import { Node, Project, ts } from "ts-morph";

import type { AgentIR } from "./agent-info";
import { discoverAgentInfo } from "./agent-info";
import type { ContainerIR } from "./container-info";
import { discoverContainerInfo } from "./container-info";
import { escapeRegExp } from "./dev-variables-format";
import { discoverIr } from "./discover-info";
import type { DiscoveryCache } from "./discovery-cache";
import { discoverFlagsInfo } from "./flags-info";
import isWithinDirectory from "./is-within-directory";
import { PACKAGE_SECRETS_REGISTRY } from "./package-secrets-registry";
import join from "./path";
import type { QueueIR } from "./queue-info";
import { discoverQueueInfo } from "./queue-info";
import type { SchemaInfo } from "./schema-info";
import { discoverSchemaInfo } from "./schema-info";
import type { DurableObjectSpec } from "./worker-entry";
import {
    composedEntryDurableObjects,
    detectClassExports,
    detectExportedDurableObjects,
    DURABLE_OBJECT_BINDINGS,
    GENERATED_DIRECTORY,
    isMergedProject,
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
//   kv          → kv_namespaces             → written without an id (wrangler creates the namespace on deploy)
//   hyperdrive  → hyperdrive                → written with a placeholder id (`lunora deploy` creates the config from a connection string)
//   browser     → browser                   → self-describing (binding name only)
//   images      → images                    → self-describing (binding name only)
//   analytics   → analytics_engine_datasets → self-describing (dataset == binding name)
//   pipelines   → pipelines                 → hint (un-mintable remote pipeline name)
//   artifacts   → artifacts                 → written with the Worker's name as namespace (a logged-out dev session leaves it out; deploy creates a pinned one)
//   aiSearch    → ai_search_namespaces      → self-describing (namespace "default" always exists; wrangler creates a missing one)
//   analyticsSql → analytics                → self-describing (binding name only; wrangler >= 4.145.0)

/**
 * Codegen's capabilities config reports, each as the flag `uses<Key>`. What marks
 * one used is not restated here: config folds the same per-file signals codegen
 * reads ({@link sourceCapabilitySignals}) and asks codegen's one matcher
 * ({@link capabilitiesUsedBy}), so a handler that makes codegen wire `ctx.kv`
 * always makes config add or hint the KV binding too. The package
 * {@link secretSourcesFromBindings} reports, and the wording of each hint, are read
 * off the row's probe ({@link CAPABILITY_PROBES}).
 */
const CODEGEN_CAPABILITIES = [
    "ai",
    "aiSearch",
    "analytics",
    "analyticsSql",
    "artifacts",
    "browser",
    "hyperdrive",
    "images",
    "kv",
    "mail",
    // No Cloudflare binding and no secrets of its own: each push channel's secrets
    // are keyed by the channel `lunora/notify.ts` configures — see SECRET_SOURCE_FLAGS.
    "notify",
    "payments",
    "pipelines",
    // Its three `R2_SQL_*` secrets are the whole config need (no binding).
    "r2sql",
    "scheduler",
    "storage",
    "x402",
] as const satisfies ReadonlyArray<CapabilityKey>;

type CodegenCapability = (typeof CODEGEN_CAPABILITIES)[number];

/** The flag a codegen capability is reported under: `kv` → `usesKv`. */
const flagOf = <K extends CodegenCapability>(key: K): `uses${Capitalize<K>}` =>
    // The one cast: TypeScript cannot follow `toUpperCase` into `Capitalize<K>`.
    `uses${key.charAt(0).toUpperCase()}${key.slice(1)}` as `uses${Capitalize<K>}`;

/**
 * The config-only flags: packages codegen wires no `ctx.*` helper for, so they
 * have no row in its table — the package's import is the whole signal.
 */
const CONFIG_ONLY_SOURCES = [
    // Usually imported statically, but a lazy `import("@lunora/auth")` where the
    // auth instance is first built needs the same hint — see FLAG_PACKAGES.
    ["usesAuth", "@lunora/auth"],
    // The Workers CIMD transport (plan 461). No binding and no signal: it needs a
    // compatibility flag, which `lunora doctor` checks against the wrangler config
    // this inference never reads.
    ["usesCimdWorkers", "@lunora/auth/cimd/workers"],
    // The x402 charge rail is an opt-in add-on subpath (not part of the `lunorash`
    // umbrella). It implies no `.dev.vars` secret: the charge recipient is a
    // user-named `[vars]` entry — hint-only. Often loaded lazily on the paid route
    // alone, which still needs the hint — see FLAG_PACKAGES.
    ["usesX402Charge", "@lunora/x402/charge"],
    // Each `@lunora/payment` adapter is its own subpath, and its import is what
    // tells which provider's secrets belong in `.dev.vars.example` — the root
    // import alone cannot say.
    ["usesPaymentAutumn", "@lunora/payment/autumn"],
    ["usesPaymentCreem", "@lunora/payment/creem"],
    ["usesPaymentDodopayments", "@lunora/payment/dodopayments"],
    ["usesPaymentPolar", "@lunora/payment/polar"],
    ["usesPaymentStripe", "@lunora/payment/stripe"],
] as const;

/** The import-driven capability flag names. */
type CapabilityFlag = (typeof CONFIG_ONLY_SOURCES)[number][0] | `uses${Capitalize<CodegenCapability>}`;

/**
 * Every flag → the package it reports, sorted by flag so
 * {@link secretSourcesFromBindings} lists sources in a stable order.
 *
 * Every row counts a dynamic `import("…")` of its package as well as a static
 * one — deliberately, for all of them: a lazily loaded package needs its binding
 * or secret just the same. Codegen ignores dynamic imports (it wires a helper off
 * a static one), so config detects a superset of codegen here — harmless for a
 * binding or a secret, where the opposite would build green and throw at runtime.
 */
const FLAG_PACKAGES: ReadonlyArray<readonly [CapabilityFlag, string]> = [
    ...CODEGEN_CAPABILITIES.map((key) => [flagOf(key), CAPABILITY_PROBES[key].moduleSpecifier] as const),
    ...CONFIG_ONLY_SOURCES,
].toSorted(([left], [right]) => left.localeCompare(right));

/**
 * The `@lunora/notify` push channels → the secrets-registry key their secrets are
 * listed under. Like a payment adapter's subpath (#1022), the channel — not the
 * package — says which secrets an app needs, so a `webPush`-only app is not told
 * to set `FCM_*`. Read from `defineNotify({...})` in `lunora/notify.ts`.
 */
const SECRET_SOURCE_FLAGS = [
    ["usesNotifyFcm", "@lunora/notify:fcm"],
    ["usesNotifyWebPush", "@lunora/notify:webPush"],
    // `ShardRegistryDO` refuses unsigned requests, so an app with a registry needs
    // `LUNORA_RELAY_SECRET` in `.dev.vars` and on deploy, with no package import to say so.
    ["hostsShardRegistry", "@lunora/do:shardRegistry"],
    // `EventLogDO` refuses every request without the same secret, and the app that exports it hosts the log.
    ["hostsEventLog", "@lunora/replica:eventLog"],
    // A worker that only constructs `EventLogDOClient` takes the host's value, so its line is a template, never minted.
    ["usesEventLogClient", "@lunora/replica:eventLogClient"],
    // The secret store behind `requestSecretTool`. The tool's own import is the
    // signal, not `@lunora/agent`: an app that imports the package for something
    // else needs no key.
    ["usesRequestSecretTool", "@lunora/agent:requestSecretTool"],
] as const;

/** The packages whose sandbox tools (`browserTool`, `jsCodeTool`) provision `BROWSER` / `LOADER` when imported under `lunora/`. */
const SANDBOX_PACKAGES = ["@lunora/agent", "@lunora/agent/sandbox"] as const;

/** The package whose barrel exports `EventLogDO` and `EventLogDOClient`, so a star re-export of it forwards the host class. */
const EVENT_LOG_PACKAGE = "@lunora/replica";

/** The export a worker constructs to reach a log, so the one whose use asks for the relay secret. */
const EVENT_LOG_CLIENT = "EventLogDOClient";

/** The source extension a `.js`-style relative specifier names, so it can be probed against the `.ts` file. */
const SOURCE_SPECIFIER_EXTENSION = /\.[cm]?[jt]sx?$/u;

/** Barrel source extensions in probe order: TypeScript first, so a `.js` specifier resolves to its `.ts` source. */
const BARREL_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Barrel files parsed so far, keyed by path. An entry is reused while the file keeps its modification time. */
const parsedModules = new Map<string, { mtimeMs: number; source: ts.SourceFile }>();

const parseModule = (modulePath: string): ts.SourceFile => {
    const { mtimeMs } = statSync(modulePath);
    const cached = parsedModules.get(modulePath);

    if (cached?.mtimeMs === mtimeMs) {
        return cached.source;
    }

    const source = ts.createSourceFile(modulePath, readFileSync(modulePath, "utf8"), ts.ScriptTarget.Latest);
    parsedModules.set(modulePath, { mtimeMs, source });

    return source;
};

/** The identifiers of a file, walked once per file: each namespace check reads this list rather than the tree. */
const identifierCache = new WeakMap<SourceFile, Identifier[]>();

const identifiersOf = (sourceFile: SourceFile): Identifier[] => {
    const cached = identifierCache.get(sourceFile);

    // A re-parse of the file forgets every node it held, so a list whose first node is forgotten is stale.
    if (cached !== undefined && cached[0]?.wasForgotten() !== true) {
        return cached;
    }

    const identifiers = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Identifier);
    identifierCache.set(sourceFile, identifiers);

    return identifiers;
};

/** The compiler options of the nearest tsconfig.json, read the way TypeScript reads them. Empty when the project has none. */
const compilerOptionsFor = (fromFile: string): ts.CompilerOptions => {
    const configPath = ts.findConfigFile(dirname(fromFile), (path) => ts.sys.fileExists(path));

    if (configPath === undefined) {
        return {};
    }

    const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

    return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath)).options;
};

/**
 * The file a re-export's specifier names. A relative specifier is probed against the TypeScript source extensions and a
 * directory's `index`. Any other specifier (a tsconfig `paths` alias, `baseUrl`) resolves the way the project's own TypeScript
 * resolves it. The replica package is matched by name before a barrel is resolved, so it is never read as a file here.
 */
const resolveBarrel = (fromFile: string, specifier: string): string | undefined => {
    if (specifier === EVENT_LOG_PACKAGE) {
        return undefined;
    }

    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, ...compilerOptionsFor(fromFile) };

        // Only the project's own sources are followed. An installed package's exports map is not read, so no node_modules file is parsed.
        const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys).resolvedModule;

        return resolved?.isExternalLibraryImport === true ? undefined : resolved?.resolvedFileName;
    }

    const stem = join(dirname(fromFile), specifier.replace(SOURCE_SPECIFIER_EXTENSION, ""));
    const files = BARREL_SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`);
    const indexes = BARREL_SOURCE_EXTENSIONS.map((extension) => join(stem, `index${extension}`));

    return [...files, ...indexes].find((candidate) => existsSync(candidate));
};

/** Where a binding reads a name from: the module it is imported or re-exported from, and the name it has there. */
interface NameSource {
    module: string;
    name: string;
}

/**
 * The named imports a file binds, keyed by local name. A type-only import compiles away, so it binds nothing the file can forward.
 */
const namedImportSources = (source: ts.SourceFile): Map<string, NameSource> => {
    const imported = new Map<string, NameSource>();

    for (const statement of source.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue;
        }

        const bindings = statement.importClause?.namedBindings;
        const elements = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [];

        for (const element of elements) {
            if (!element.isTypeOnly) {
                imported.set(element.name.text, { module: statement.moduleSpecifier.text, name: (element.propertyName ?? element.name).text });
            }
        }
    }

    return imported;
};

/** The namespace imports a file binds, keyed by local name, with the module each is imported from. A type-only import binds nothing at runtime. */
const namespaceImportSources = (source: ts.SourceFile): Map<string, string> => {
    const namespaces = new Map<string, string>();

    for (const statement of source.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue;
        }

        const bindings = statement.importClause?.namedBindings;

        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
        }
    }

    return namespaces;
};

/**
 * One export a module makes that forwards from another module. `exported` is the name it is exported under, or `undefined` for a
 * star re-export, which carries the requested name through unchanged. `name` is the name read from `module`, or `undefined` for a star.
 */
interface ModuleExport {
    exported: string | undefined;
    module: string;
    name: string | undefined;
}

/** Whether a declaration carries the `export` keyword. */
const isExported = (statement: ts.Node): boolean =>
    ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** The names one top-level statement exports from its own declaration: a local `export`, or the local names of `export { a }`. */
const localNamesExportedBy = (statement: ts.Statement): string[] => {
    if (ts.isVariableStatement(statement)) {
        return isExported(statement)
            ? statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []))
            : [];
    }

    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && isExported(statement)) {
        return statement.name === undefined ? [] : [statement.name.text];
    }

    if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        !statement.isTypeOnly &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
    ) {
        return statement.exportClause.elements.map((element) => element.name.text);
    }

    return [];
};

/**
 * The names a module exports from its own declarations: `export class`, `export function`, `export const`, and `export { a }` of a
 * local binding. An explicit export shadows a star re-export of the same name, so these are not forwarded from the star.
 */
const localExportNames = (source: ts.SourceFile): Set<string> => new Set(source.statements.flatMap((statement) => localNamesExportedBy(statement)));

/**
 * The export an initializer reads when it names an imported binding (`EventLogDO`) or a property of an imported namespace
 * (`replica.EventLogDO`). Any other expression reads no export.
 */
const importedExportOf = (
    expression: ts.Expression,
    imported: ReadonlyMap<string, NameSource>,
    namespaces: ReadonlyMap<string, string>,
): NameSource | undefined => {
    if (ts.isIdentifier(expression)) {
        return imported.get(expression.text);
    }

    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        const module = namespaces.get(expression.expression.text);

        return module === undefined ? undefined : { module, name: expression.name.text };
    }

    return undefined;
};

/**
 * The exports an `export const x = y` statement makes when `y` reads an imported name: a value copy of the imported class forwards it
 * as surely as a re-export does. Any other initializer forwards nothing.
 */
const valueExportsOf = (
    statement: ts.VariableStatement,
    imported: ReadonlyMap<string, NameSource>,
    namespaces: ReadonlyMap<string, string>,
): ModuleExport[] => {
    if (!isExported(statement)) {
        return [];
    }

    return statement.declarationList.declarations.flatMap((declaration): ModuleExport[] => {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
            return [];
        }

        const binding = importedExportOf(declaration.initializer, imported, namespaces);

        return binding === undefined ? [] : [{ exported: declaration.name.text, module: binding.module, name: binding.name }];
    });
};

/**
 * The export an exported class makes when it extends a name the file imported, such as `export class Log extends EventLogDO`. A subclass
 * inherits the base's `fetch`, so it serves the same routes as the imported class does.
 */
const subclassExportsOf = (statement: ts.ClassDeclaration, imported: ReadonlyMap<string, NameSource>): ModuleExport[] => {
    const base = statement.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;

    if (!isExported(statement) || statement.name === undefined || base === undefined || !ts.isIdentifier(base)) {
        return [];
    }

    const binding = imported.get(base.text);

    return binding === undefined ? [] : [{ exported: statement.name.text, module: binding.module, name: binding.name }];
};

/**
 * Every export of a module that forwards from another module: `export { a as b } from "m"`, an export of a name it imported,
 * `export const b = a` of a name it imported, and `export * from "m"`. Read from the syntax tree, so a comment or string forwards
 * nothing. `export * as ns` binds a namespace, not the names, so it is skipped.
 */
const forwardedExports = (source: ts.SourceFile): ModuleExport[] => {
    const imported = namedImportSources(source);
    const namespaces = namespaceImportSources(source);

    return source.statements.flatMap((statement): ModuleExport[] => {
        if (ts.isVariableStatement(statement)) {
            return valueExportsOf(statement, imported, namespaces);
        }

        if (ts.isClassDeclaration(statement)) {
            return subclassExportsOf(statement, imported);
        }

        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
            return [];
        }

        const { exportClause, moduleSpecifier } = statement;
        const from = moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : undefined;

        if (exportClause === undefined) {
            return from === undefined ? [] : [{ exported: undefined, module: from, name: undefined }];
        }

        if (!ts.isNamedExports(exportClause)) {
            return [];
        }

        return exportClause.elements.flatMap((element): ModuleExport[] => {
            if (element.isTypeOnly) {
                return [];
            }

            const exported = element.name.text;
            const local = (element.propertyName ?? element.name).text;

            if (from !== undefined) {
                return [{ exported, module: from, name: local }];
            }

            const binding = imported.get(local);

            return binding === undefined ? [] : [{ exported, module: binding.module, name: binding.name }];
        });
    });
};

/**
 * Whether a module forwards the replica package's `target` export under `requested`, or under any name when `requested` is `undefined`
 * (the worker entry: any export the worker makes of the event-log class hosts the log). A relative barrel is asked for the name its
 * export reads, so `export { Log as EventLogDO } from "./barrel"` asks the barrel for `Log`. `visited` ends a barrel cycle: a module
 * asked for the same name twice forwards nothing new.
 */
const forwardsReplicaExport = (
    modulePath: string,
    target: string,
    requested: string | undefined,
    visited: Set<string>,
    hidden: ReadonlySet<string> = new Set(),
): boolean => {
    // The result depends on the names hidden along this path, so a module reached under different hiding is visited again.
    const key = JSON.stringify([modulePath, requested, [...hidden]]);

    if (visited.has(key)) {
        return false;
    }

    visited.add(key);

    const source = parseModule(modulePath);
    const forwards = forwardedExports(source);
    // A star re-export's copy of a name is hidden by an export of that name in this module or in an outer one.
    const shadowed = new Set([
        ...hidden,
        ...localExportNames(source),
        ...forwards.flatMap((forward) => (forward.exported === undefined ? [] : [forward.exported])),
    ]);

    return forwards.some((forward) => {
        if (requested !== undefined && forward.exported !== undefined && forward.exported !== requested) {
            return false;
        }

        // An explicit export that an outer module exports under the same name is hidden there, so it forwards nothing here.
        if (forward.exported !== undefined && hidden.has(forward.exported)) {
            return false;
        }

        if (forward.exported === undefined) {
            // A star of the replica package supplies `target` when no name is requested; any other star supplies only the requested name.
            const suppliedName = requested ?? (forward.module === EVENT_LOG_PACKAGE ? target : undefined);

            if (suppliedName !== undefined && shadowed.has(suppliedName)) {
                return false;
            }
        }

        // A star carries the requested name through; a named export reads the name its specifier names.
        const name = forward.exported === undefined ? requested : forward.name;

        if (forward.module === EVENT_LOG_PACKAGE) {
            return name === undefined || name === target;
        }

        const barrel = resolveBarrel(modulePath, forward.module);

        // A star's copy of a name is hidden by every export of this module, so the barrel it reads is asked with those names hidden.
        return barrel !== undefined && forwardsReplicaExport(barrel, target, name, visited, forward.exported === undefined ? shadowed : hidden);
    });
};

/**
 * Whether a file reads `EventLogDOClient` through the namespace import bound as `localName`. A member read of another export builds
 * no client, so `ns.EventLogDO` asks for nothing. Any other use (the bare namespace, `ns["…"]`, `typeof ns`) could reach the client.
 */
const namespaceReachesClient = (sourceFile: SourceFile, localName: string): boolean =>
    identifiersOf(sourceFile).some((identifier) => {
        const parent = identifier.getParent();

        // The namespace's own declaration, and a property that only shares its name, are not uses of it.
        if (
            identifier.getText() !== localName ||
            Node.isNamespaceImport(parent) ||
            (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) ||
            (Node.isQualifiedName(parent) && parent.getRight() === identifier)
        ) {
            return false;
        }

        if (Node.isPropertyAccessExpression(parent)) {
            return parent.getName() === EVENT_LOG_CLIENT;
        }

        if (Node.isQualifiedName(parent)) {
            // A type reference names a type, which builds nothing, so `ns.EventLogDOClient` in a type position is not a runtime use.
            return !Node.isTypeReference(parent.getParent()) && parent.getRight().getText() === EVENT_LOG_CLIENT;
        }

        return true;
    });

/** Whether `call` is `import()` of the replica package, with a string or no-substitution template specifier. */
const isReplicaImportCall = (call: CallExpression): boolean => {
    const [specifier] = call.getArguments();

    return (
        call.getExpression().getKind() === ts.SyntaxKind.ImportKeyword &&
        specifier !== undefined &&
        (Node.isStringLiteral(specifier) || Node.isNoSubstitutionTemplateLiteral(specifier)) &&
        specifier.getLiteralValue() === EVENT_LOG_PACKAGE
    );
};

/** The name a destructured element reads from the module: a quoted or computed string key names its value, not its source text. */
const bindingKeyOf = (element: BindingElement): string => {
    const key = element.getPropertyNameNode();

    if (key === undefined) {
        return element.getNameNode().getText();
    }

    const literal = Node.isComputedPropertyName(key) ? key.getExpression() : key;

    return Node.isStringLiteral(literal) || Node.isNoSubstitutionTemplateLiteral(literal) ? literal.getLiteralValue() : key.getText();
};

/**
 * Whether a dynamic `import("@lunora/replica")` reaches `EventLogDOClient`. Unawaited it is a promise that any `.then` can read, so it
 * counts. Awaited, its members are reachable: a destructuring counts when it names the client or takes a rest element, and a member
 * read counts only when it is the client.
 */
const dynamicImportReachesClient = (call: CallExpression): boolean => {
    let value: Node = call;
    let awaited = false;

    // Step over parentheses and `await` to the expression that consumes the module object.
    for (let parent = call.getParent(); Node.isParenthesizedExpression(parent) || Node.isAwaitExpression(parent); parent = value.getParent()) {
        awaited ||= Node.isAwaitExpression(parent);
        value = parent;
    }

    if (!awaited) {
        return true;
    }

    const consumer = value.getParent();

    if (Node.isVariableDeclaration(consumer)) {
        const binding = consumer.getNameNode();

        return (
            !Node.isObjectBindingPattern(binding) ||
            binding.getElements().some((element) => element.getDotDotDotToken() !== undefined || bindingKeyOf(element) === EVENT_LOG_CLIENT)
        );
    }

    if (Node.isPropertyAccessExpression(consumer) && consumer.getExpression() === value) {
        return consumer.getName() === EVENT_LOG_CLIENT;
    }

    return true;
};

/** Whether a module re-exports the replica package as a namespace under `name`: `export * as name from "@lunora/replica"`. */
const exportsReplicaNamespace = (modulePath: string, name: string): boolean =>
    parseModule(modulePath).statements.some(
        (statement) =>
            ts.isExportDeclaration(statement) &&
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === EVENT_LOG_PACKAGE &&
            statement.exportClause !== undefined &&
            ts.isNamespaceExport(statement.exportClause) &&
            statement.exportClause.name.text === name,
    );

/**
 * Whether a file reaches `EventLogDOClient` through a relative module that forwards it from the replica package, through any chain of
 * barrels: by a named import, or through a namespace import the file reads the client from. Such a file constructs the client without
 * naming the package itself.
 */
const importsClientFromBarrel = (sourceFile: SourceFile): boolean =>
    sourceFile.getImportDeclarations().some((declaration) => {
        // The cheap check first: the barrel is only read for an import that names the client or reads it through a namespace.
        const namespace = declaration.getNamespaceImport();
        const namedImports = declaration.isTypeOnly() ? [] : declaration.getNamedImports().filter((specifier) => !specifier.isTypeOnly());
        const namesClient = namedImports.some((specifier) => specifier.getNameNode().getText() === EVENT_LOG_CLIENT);
        const namedNamespaces = namedImports.filter((specifier) =>
            namespaceReachesClient(sourceFile, (specifier.getAliasNode() ?? specifier.getNameNode()).getText()),
        );
        const namespaceClient = namespace !== undefined && namespaceReachesClient(sourceFile, namespace.getText());

        if (!namesClient && !namespaceClient && namedNamespaces.length === 0) {
            return false;
        }

        const barrel = resolveBarrel(sourceFile.getFilePath(), declaration.getModuleSpecifierValue());

        if (barrel === undefined) {
            return false;
        }

        // A namespace the barrel re-exports from the replica package carries the client under the name the file reads it by.
        return (
            ((namesClient || namespaceClient) && forwardsReplicaExport(barrel, EVENT_LOG_CLIENT, EVENT_LOG_CLIENT, new Set())) ||
            namedNamespaces.some((specifier) => exportsReplicaNamespace(barrel, specifier.getNameNode().getText()))
        );
    });

/**
 * Whether a file constructs `EventLogDOClient`. The client throws at construction without the relay secret, so a type-only binding,
 * which builds nothing, asks for none. A namespace import or a dynamic `import()` of the package asks only where it reaches the client:
 * a worker that loads other replica exports must not be told to set a secret it never reads.
 */
const constructsEventLogClient = (sourceFile: SourceFile): boolean => {
    const replicaImports = sourceFile
        .getImportDeclarations()
        .filter((declaration) => declaration.getModuleSpecifierValue() === EVENT_LOG_PACKAGE && !declaration.isTypeOnly());

    return (
        replicaImports.some((declaration) =>
            declaration.getNamedImports().some((specifier) => !specifier.isTypeOnly() && specifier.getNameNode().getText() === EVENT_LOG_CLIENT),
        ) ||
        replicaImports.some((declaration) => {
            const namespace = declaration.getNamespaceImport();

            return namespace !== undefined && namespaceReachesClient(sourceFile, namespace.getText());
        }) ||
        sourceFile
            .getExportDeclarations()
            .some(
                (declaration) =>
                    declaration.getModuleSpecifierValue() === EVENT_LOG_PACKAGE &&
                    !declaration.isTypeOnly() &&
                    declaration.getNamedExports().some((specifier) => !specifier.isTypeOnly() && specifier.getNameNode().getText() === EVENT_LOG_CLIENT),
            ) ||
        importsClientFromBarrel(sourceFile) ||
        sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression).some((call) => isReplicaImportCall(call) && dynamicImportReachesClient(call))
    );
};

/**
 * The parse prefilter: a file naming no capability package in quotes — the form
 * every static import, re-export and literal dynamic `import()` takes — and
 * reading no `ctx` helper ({@link mayReadCapabilityContext}) is never handed to
 * the TypeScript parser. Plain text, so it also holds for a file a module lexer
 * rejects (JSX, a mid-edit syntax error), which used to be parsed unconditionally.
 */
const CAPABILITY_PACKAGE_PATTERN = new RegExp(
    String.raw`["'\x60](?:${[...FLAG_PACKAGES.map(([, source]) => source), ...SANDBOX_PACKAGES, EVENT_LOG_PACKAGE].map((source) => escapeRegExp(source)).join("|")})["'\x60]`,
    "u",
);

/** The hint clause naming what marks a codegen capability used, read off its probe — `@lunora/bindings/kv is imported or ctx.kv is read`. */
const usageOf = (key: CodegenCapability): string => {
    const { contextProperty, moduleSpecifier } = CAPABILITY_PROBES[key];

    return contextProperty === undefined ? `${moduleSpecifier} is imported` : `${moduleSpecifier} is imported or ctx.${contextProperty} is read`;
};

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

    /** The worker entry exports `EventLogDO`, so the app mints the `LUNORA_RELAY_SECRET` the event log checks on every request. */
    hostsEventLog: boolean;

    /** The app hosts the registry (exports or binds `ShardRegistryDO`, or is merged with its module), so it mints the `LUNORA_RELAY_SECRET` its registry checks. */
    hostsShardRegistry: boolean;

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
    /** `@lunora/bindings/ai-search` is value-imported or `ctx.aiSearch` read → self-describing `ai_search_namespaces` binding (`AI_SEARCH` on namespace `default`; auto-writeable). */
    usesAiSearch: boolean;
    /** `@lunora/bindings/analytics` is imported or `ctx.analytics` read → self-describing `analytics_engine_datasets` binding (auto-writeable). */
    usesAnalytics: boolean;
    /** `@lunora/bindings/analytics-sql` is value-imported or `ctx.analyticsSql` read → self-describing `analytics` binding (`{ binding: ANALYTICS_SQL }`; auto-writeable, wrangler >= 4.145.0). */
    usesAnalyticsSql: boolean;

    /**
     * `ctx.artifacts` is read or `@lunora/bindings/artifacts` value-imported.
     * Reconcile writes the binding with the Worker's name as its namespace. The first repo
     * `create()` against a missing namespace creates it UNRESTRICTED and the jurisdiction can
     * never change after that, so `lunora deploy` creates a pinned schema's namespace in its
     * jurisdiction, and stops when it can't.
     */
    usesArtifacts: boolean;
    /** `@lunora/auth` is imported (sessions may be D1- or `SessionDO`-backed). */
    usesAuth: boolean;
    /** `@lunora/browser` is imported or `ctx.browser` read → self-describing `browser` binding (auto-writeable). */
    usesBrowser: boolean;
    /** `@lunora/auth/cimd/workers` is imported → needs the `global_fetch_strictly_public` compatibility flag (no binding; `lunora doctor` checks it). */
    usesCimdWorkers: boolean;
    /** The app constructs an `EventLogDOClient`, so it needs the `LUNORA_RELAY_SECRET` its host minted, hosting the log or not. */
    usesEventLogClient: boolean;
    /** `lunora/flags.ts` declares a feature-flag provider (any OpenFeature provider — Flagship or custom). */
    usesFlags: boolean;
    /** `@lunora/hyperdrive` is imported or `ctx.sql` read (reconcile writes `{ binding: "HYPERDRIVE" }` with a placeholder `id`; `lunora deploy` swaps in the created config's). */
    usesHyperdrive: boolean;
    /** `@lunora/bindings/images` is imported or `ctx.images` read → self-describing `images` binding (auto-writeable). */
    usesImages: boolean;
    /** `@lunora/bindings/kv` is imported or `ctx.kv` read (reconcile writes `{ binding: "KV" }` without an id and wrangler creates the namespace on deploy, unless the schema pins a jurisdiction). */
    usesKv: boolean;
    /** `@lunora/mail` is imported (Resend API key must be set in `.dev.vars`; no binding). No `ctx.mail` helper exists, so only the import counts. */
    usesMail: boolean;
    /** `@lunora/notify` is imported or `ctx.notify` read (no binding; channel secrets ride `usesNotifyFcm` / `usesNotifyWebPush`). */
    usesNotify: boolean;
    /** `lunora/notify.ts` configures the `fcm` channel → the `FCM_*` secrets in `.dev.vars`. */
    usesNotifyFcm: boolean;
    /** `lunora/notify.ts` configures the `webPush` channel → the `VAPID_*` secrets in `.dev.vars`. */
    usesNotifyWebPush: boolean;
    /** `@lunora/payment/autumn` is imported → the Autumn secrets in `.dev.vars` (no binding). */
    usesPaymentAutumn: boolean;
    /** `@lunora/payment/creem` is imported → the Creem secrets in `.dev.vars` (no binding). */
    usesPaymentCreem: boolean;
    /** `@lunora/payment/dodopayments` is imported → the Dodo Payments secrets in `.dev.vars` (no binding). */
    usesPaymentDodopayments: boolean;
    /** `@lunora/payment/polar` is imported → the Polar secrets in `.dev.vars` (no binding). */
    usesPaymentPolar: boolean;
    /** `@lunora/payment` is imported or `ctx.payments` read (provider secrets must be set in `.dev.vars`; no binding). */
    usesPayments: boolean;
    /** `@lunora/payment/stripe` is imported → the Stripe secrets in `.dev.vars` (no binding). */
    usesPaymentStripe: boolean;
    /** `@lunora/bindings/pipelines` is value-imported or `ctx.pipelines` read (binding needs an un-mintable remote pipeline name; hint-only). */
    usesPipelines: boolean;
    /** `@lunora/bindings/r2sql` is value-imported or `ctx.r2sql` read (needs the `R2_SQL_*` secrets in `.dev.vars`; no binding). */
    usesR2sql: boolean;
    /** `lunora/` value-imports `requestSecretTool` from `@lunora/agent` → the `LUNORA_SECRET_VALUE_KEY` secret in `.dev.vars` (no binding). Read off the same rule codegen gates on. */
    usesRequestSecretTool: boolean;
    /** `@lunora/scheduler` is imported or `ctx.scheduler` read. */
    usesScheduler: boolean;
    /** `@lunora/storage` is imported or `ctx.storage` read under `lunora/` (R2 bucket binding name is user-defined). */
    usesStorage: boolean;
    /** `jsCodeTool` is imported from `@lunora/agent` in `lunora/` → self-describing `worker_loaders` binding (`LOADER`). */
    usesWorkerLoader: boolean;
    /** `@lunora/x402/pay` is imported or `ctx.x402` read — the agent-wallet pay rail signs from a Secrets Store binding paired with a spend policy (ActionCtx-only; hint-only). */
    usesX402: boolean;
    /** `@lunora/x402/charge` is imported — the charge rail settles USDC to a recipient address (a public `[vars]` entry, user-named; hint-only). */
    usesX402Charge: boolean;
    /** Workflows declared in `lunora/workflows.ts` (exported or not — see {@link InferredWorkflow.exported}). */
    workflows: InferredWorkflow[];
}

/**
 * Which capabilities the scanned project uses. A plain value built once from the
 * folded signals: the import-driven flags are {@link FLAG_PACKAGES}'s; `needsD1`
 * (an `env.DB` read) and `usesWorkerLoader` (a sandbox `jsCodeTool` import) are
 * the two not driven by a package import, so they are added explicitly. A `Pick`
 * of {@link InferredBindings}, so a flag the result does not declare fails to compile.
 */
type Capabilities = Pick<InferredBindings, CapabilityFlag | "needsD1" | "usesEventLogClient" | "usesRequestSecretTool" | "usesWorkerLoader">;

/** A capability scan and every file it read, so a later walk from the worker entry leaves those files alone. */
type CapabilityScan = Capabilities & { scannedFiles: ReadonlySet<string> };

/** A relative module specifier in an import or re-export: `from "./x"`, `from "../y"`. */
const RELATIVE_IMPORT_PATTERN = /\bfrom\s+["']\.{1,2}\//u;

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
    /** Memoises the source scans, so one CLI invocation parses the project once. */
    cache?: DiscoveryCache;
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
const schemaFacts = (projectRoot: string, schemaDirectory: string, cache?: DiscoveryCache): SchemaFacts => {
    const { info } = discoverSchemaInfo(projectRoot, schemaDirectory, cache);

    return { jurisdiction: info?.jurisdiction, needsD1: info?.hasD1GlobalTable ?? false };
};

/**
 * The parse the last {@link scanCapabilities} left, for the project it scanned. A
 * watch session scans on every codegen pass, and re-parsing every candidate file
 * each time was most of the scan; a file is re-parsed only when its text changed,
 * so nothing stale is ever read. Only the latest project is kept: a host scans one,
 * and one that alternates re-parses on each switch, no worse than not caching.
 */
let lastScan: { project: Project; root: string } | undefined;

/** The project {@link lastScan} keeps for `projectRoot`, replacing another root's. */
const scanProjectOf = (projectRoot: string): Project => {
    const root = resolve(projectRoot);

    if (lastScan?.root !== root) {
        lastScan = { project: new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true }), root };
    }

    return lastScan.project;
};

/** Parse `code` into `project` as `file`, unless the file is already there with exactly this text. */
const parseIfChanged = (project: Project, file: string, code: string): void => {
    if (project.getSourceFile(file)?.getFullText() !== code) {
        project.createSourceFile(file, code, { overwrite: true });
    }
};

/** Drop every file the last scan parsed and this one did not — a deleted file, or one no longer worth parsing. */
const forgetUnscanned = (project: Project, scanned: ReadonlySet<SourceFile>): void => {
    for (const sourceFile of project.getSourceFiles()) {
        if (!scanned.has(sourceFile)) {
            project.removeSourceFile(sourceFile);
        }
    }
};

/**
 * Scan every source file under `scanDirectories` and decide the capabilities.
 *
 * Each file worth parsing (see {@link CAPABILITY_PACKAGE_PATTERN}) contributes
 * its signals, and the signals are folded ONCE, per file set, before a single
 * call to codegen's matcher. Two of them count only under `lunoraDirectory`, the
 * file set codegen probes: `ctx.<property>` reads — that is the only place a read
 * gets the helper wired, and a hand-written Durable Object in `src/` reading its
 * own `ctx.storage` (the `DurableObjectState`) must not hint an R2 bucket — and
 * sandbox-tool imports, since `discoverSandboxUsage` only reads `lunora/`, so a
 * `src/`-only `browserTool` never registers the dispatcher and a `src/`-only
 * `jsCodeTool` never reaches the `workerLoaders` gate.
 */
const scanCapabilities = (projectRoot: string, scanDirectories: ReadonlyArray<string>, lunoraDirectory: string): CapabilityScan => {
    const lunoraRoot = join(projectRoot, lunoraDirectory);
    const project = scanProjectOf(projectRoot);
    const candidates: { file: string; inLunora: boolean }[] = [];
    const scannedFiles = new Set<string>();
    const lunoraFiles: SourceCapabilitySignals[] = [];
    const otherFiles: SourceCapabilitySignals[] = [];
    // One scope for the whole scan: a target a barrel reaches from several files is parsed once.
    const targets = createTargetScope();
    let usesEnvAi = false;
    let usesEnvDatabase = false;

    for (const relativeDirectory of scanDirectories) {
        const absolute = join(projectRoot, relativeDirectory);

        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            continue;
        }

        const files: string[] = [];

        collectSourceFiles(absolute, files);

        for (const file of files) {
            scannedFiles.add(file);

            const code = readFileSync(file, "utf8");
            const inLunora = isWithinDirectory(file, lunoraRoot);

            usesEnvAi ||= ENV_AI_PATTERN.test(code);
            usesEnvDatabase ||= ENV_DB_PATTERN.test(code);

            // A `lunora/` file that imports a relative module can reach a capability through that module (a barrel that
            // re-exports the agent package's tool), so it is parsed even without a package name or context read there.
            // A file that names the client may import it from a barrel that is not a candidate, so it is parsed for that import too.
            if (
                CAPABILITY_PACKAGE_PATTERN.test(code) ||
                code.includes(EVENT_LOG_CLIENT) ||
                (inLunora && (mayReadCapabilityContext(code) || RELATIVE_IMPORT_PATTERN.test(code)))
            ) {
                // Registered now, while the program is not built, so the text is not kept for the signal pass. A file
                // whose text is unchanged since the last scan keeps its parse — and with it codegen's per-file caches.
                parseIfChanged(project, file, code);

                candidates.push({ file, inLunora });
            }
        }
    }

    // Forget what the last scan parsed and this one did not (a deleted file, or one no longer worth parsing), before any
    // signal is read, so the project holds exactly this scan's file set.
    // By identity, not by path string: ts-morph stores a standardized absolute path, which a relative root or a
    // Windows spelling of `file` would never equal.
    forgetUnscanned(project, new Set(candidates.map(({ file }) => project.getSourceFileOrThrow(file))));

    // Each file's signals come from `@lunora/codegen`'s own per-file probe over a parsed AST, so a type-only import, or a
    // `ctx.kv` inside a comment or a string, implies nothing here, exactly as it implies nothing to codegen. Every candidate
    // is in the project before any is read: removing a file after its own read made the next relative import re-resolve
    // against a rebuilt program, which took minutes on a backend with a few hundred files.
    for (const { file, inLunora } of candidates) {
        (inLunora ? lunoraFiles : otherFiles).push(sourceCapabilitySignals(project.getSourceFileOrThrow(file), targets));
    }

    const lunora = foldCapabilitySignals(lunoraFiles);
    const everywhere = foldCapabilitySignals([lunora, ...otherFiles]);
    // Config counts a dynamic `import()` like a static one (see FLAG_PACKAGES).
    const imports = new Set([...everywhere.valueImports, ...everywhere.dynamicImports]);
    const used = capabilitiesUsedBy({ contextReads: lunora.contextReads, valueImports: imports });
    // The one widening `Object.fromEntries` forces: its keys are exactly the `CapabilityFlag`s.
    const flags = Object.fromEntries([
        ...CODEGEN_CAPABILITIES.map((key) => [flagOf(key), used.has(key)] as const),
        ...CONFIG_ONLY_SOURCES.map(([flag, source]) => [flag, imports.has(source)] as const),
    ]) as Record<CapabilityFlag, boolean>;

    return {
        ...flags,
        needsD1: usesEnvDatabase,
        usesEventLogClient: candidates.some(({ file }) => constructsEventLogClient(project.getSourceFileOrThrow(file))),
        usesRequestSecretTool: lunora.requestSecretTool,
        usesAi: used.has("ai") || usesEnvAi,
        // A sandbox `browserTool` provisions BROWSER even without a direct
        // `@lunora/browser` import: the browser op runs on the dispatcher's ctx.
        usesBrowser: used.has("browser") || lunora.sandboxTools.usesSandboxBrowser,
        usesWorkerLoader: lunora.sandboxTools.usesSandboxLoader,
        scannedFiles,
    };
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
        [capabilities.usesAi, `AI (${usageOf("ai")}, or env.AI is used)`],
        [
            capabilities.usesAuth && !exported.has("SessionDO"),
            "hint: @lunora/auth is imported; its tables are D1-backed by default. For DO-backed auth (what @better-auth/scim needs), pass `namespace` to .auth() and export the generated auth DO class",
        ],
        [capabilities.usesScheduler && !exported.has("SchedulerDO"), `hint: ${usageOf("scheduler")}, but no SchedulerDO is exported by the worker entry`],
        [capabilities.usesStorage, `hint: ${usageOf("storage")}; add an r2_buckets binding (bucket binding names are user-defined)`],
        [capabilities.usesMail, `hint: ${usageOf("mail")}; set RESEND_API_KEY in .dev.vars (obtain at https://resend.com/api-keys)`],
        [capabilities.usesPayments, `hint: ${usageOf("payments")}; set the provider secrets in .dev.vars — ${PAYMENT_PROVIDER_SECRETS}`],
        // Self-describing bindings: the binding name is the whole config (no remote
        // id to mint), so reconcile auto-writes them like the DO/D1 bindings.
        [capabilities.usesBrowser, `browser (${usageOf("browser")}, or a sandbox browserTool imported in lunora/) — self-describing { binding: BROWSER }`],
        [capabilities.usesImages, `images (${usageOf("images")}) — self-describing { binding: IMAGES }`],
        [capabilities.usesAnalytics, `analytics_engine_datasets (${usageOf("analytics")}) — self-describing { binding: ANALYTICS, dataset }`],
        [capabilities.usesWorkerLoader, "worker_loaders (jsCodeTool imported in lunora/) — self-describing { binding: LOADER }"],
        [
            capabilities.usesAiSearch,
            `ai_search_namespaces (${usageOf("aiSearch")}) — self-describing { binding: AI_SEARCH, namespace: "default" }; remote-only, so \`lunora dev\` reaches the deployed AI Search service`,
        ],
        [
            capabilities.usesAnalyticsSql,
            `analytics (${usageOf("analyticsSql")}) — self-describing { binding: ANALYTICS_SQL }; needs wrangler >= 4.145.0, and is remote-only, so \`lunora dev\` queries the account's live analytics`,
        ],
        // Hint bindings: each needs a remote resource Lunora can't fabricate (a
        // Pipelines pipeline name), so they surface as hints — never an
        // auto-write — exactly like R2's user-defined bucket name.
        [
            capabilities.usesKv,
            schema.jurisdiction === undefined
                ? `kv_namespaces (${usageOf("kv")}) — { binding: KV } with no id; wrangler creates the namespace on the first deploy`
                : `hint: ${usageOf("kv")} and the schema pins "${schema.jurisdiction}"; create the namespace with --jurisdiction ${schema.jurisdiction} and add a kv_namespaces binding ({ binding, id })`,
        ],
        [
            capabilities.usesHyperdrive,
            `hyperdrive (${usageOf("hyperdrive")}) — { binding: HYPERDRIVE } with a placeholder id; dev uses an embedded Postgres and \`lunora deploy\` creates the config`,
        ],
        [
            capabilities.usesPipelines,
            `hint: ${usageOf("pipelines")}; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, stream }) — the pipeline resource can't be auto-provisioned`,
        ],
        [
            capabilities.usesArtifacts,
            schema.jurisdiction === undefined
                ? `artifacts (${usageOf("artifacts")}) — { binding: ARTIFACTS, namespace }`
                : `hint: ${usageOf("artifacts")}; the schema pins data to "${schema.jurisdiction}", so create the namespace in that jurisdiction first and add { binding: ARTIFACTS, namespace } yourself — \`lunora deploy\` then checks it (a first create() in dev would make it unrestricted)`,
        ],
        [
            capabilities.usesX402Charge,
            "hint: @lunora/x402/charge is imported; set the recipient wallet address as a [vars] entry (the var name is yours to choose) and pass it to the charge config — the x402 facilitator settles USDC to that address",
        ],
        [
            capabilities.usesX402,
            `hint: ${usageOf("x402")} (ActionCtx-only, spends real funds); add a secrets_store_secrets[] binding for the agent wallet key (name it to match signer.secretName) and pair the pay rail with a spend policy — ctx.secrets reads a Secrets Store binding, not .dev.vars, so the key can't be auto-provisioned`,
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
 * Whether the app hosts `ShardRegistryDO`: it exports or binds the class, or a merged app carries the
 * registry in `LunoraDO`. codegen writes `shardRegistry.ts` for every `.shardBy()` schema, so the file's
 * presence alone does not host the registry.
 */
const hostsShardRegistry = (durableObjects: ReadonlyArray<DurableObjectSpec>, generatedDirectory: string): boolean =>
    durableObjects.some((object) => object.binding === "SHARD_REGISTRY") ||
    (isMergedProject(generatedDirectory) && existsSync(join(generatedDirectory, "shardRegistry.ts")));

/**
 * The module specifiers a file loads at run time: static imports and re-exports, and an `import()` of a string literal. A type-only
 * declaration compiles away, so it loads nothing.
 */
const runtimeSpecifiersOf = (source: ts.SourceFile): string[] => {
    const specifiers: string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments;

            if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
                specifiers.push(argument.text);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return specifiers;
};

/**
 * Whether the worker entry constructs `EventLogDOClient`, in its own file or in a module it reaches through local imports. The entry can
 * sit outside the scanned directories (a root-level `worker.ts`), and so can the modules it imports, while construction needs the secret
 * wherever it is. A module `scanCapabilities` already read is a leaf: its constructions were counted there, and it is not parsed twice.
 * Generated modules are leaves too, since codegen never emits a client construction. Imports are read from the TypeScript parse of each
 * module, and a file only reaches the ts-morph parse when its text names the client or a capability package.
 */
const entryConstructsEventLogClient = (entryPath: string, scannedFiles: ReadonlySet<string>, generatedRoot: string): boolean => {
    const project = new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true });
    const pending = [entryPath];
    const visited = new Set<string>();

    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        if (visited.has(file)) {
            continue;
        }

        visited.add(file);

        const source = parseModule(file);
        const code = source.text;

        if (
            (CAPABILITY_PACKAGE_PATTERN.test(code) || code.includes(EVENT_LOG_CLIENT)) &&
            constructsEventLogClient(project.createSourceFile(file, code, { overwrite: true }))
        ) {
            return true;
        }

        for (const specifier of runtimeSpecifiersOf(source)) {
            const target = resolveBarrel(file, specifier);

            if (target !== undefined && !scannedFiles.has(target) && !isWithinDirectory(target, generatedRoot)) {
                pending.push(target);
            }
        }
    }

    return false;
};

/**
 * Whether the worker entry hosts `EventLogDO`. A composed entry star-re-exports only the generated
 * modules, so it never hosts the log by itself. A hand-written entry can reach the class through a
 * barrel, so star re-exports are followed rather than reading only the entry's own export list.
 */
const hostsEventLog = (entry: ReturnType<typeof resolveWorkerEntry>): boolean =>
    !entry.composed && entry.path !== undefined && forwardsReplicaExport(entry.path, "EventLogDO", undefined, new Set());

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

    const scan = (): CapabilityScan => scanCapabilities(options.projectRoot, scanDirectories, schemaDirectory);
    const { scannedFiles, ...capabilities } =
        options.cache === undefined ? scan() : options.cache.memo(`capabilities:${options.projectRoot}:${schemaDirectory}:${scanDirectories.join(",")}`, scan);
    const entry = resolveWorkerEntry(options.projectRoot);
    let durableObjects: DurableObjectSpec[];

    if (entry.composed) {
        // Plus `SchedulerDO` / `ShardRegistryDO` when codegen wrote the module
        // that forwards it: the composed entry star-re-exports it, so the class
        // IS exported and the binding is provisionable. Reading only the base list above left
        // `reconcile-bindings` telling a correctly-wired class-A app to
        // "export it so the SCHEDULER binding can be provisioned" — advice that is
        // both wrong and impossible to follow, on every `lunora dev`.
        // A merging app exports `LunoraDO` instead.
        const composedClasses = composedEntryDurableObjects(join(options.projectRoot, schemaDirectory, GENERATED_DIRECTORY));

        durableObjects = composedClasses.map((className) => {
            return { binding: DURABLE_OBJECT_BINDINGS[className], className };
        });
    } else {
        durableObjects = entry.path === undefined ? [] : detectExportedDurableObjects(entry.path);
    }

    const discoveredSchema = schemaFacts(options.projectRoot, schemaDirectory, options.cache);
    const schema: SchemaFacts = { ...discoveredSchema, needsD1: capabilities.needsD1 || discoveredSchema.needsD1 };
    const containers = detectClassExports(entry, discoverContainerInfo(options.projectRoot, schemaDirectory, options.cache).containers, "containers");
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
    const notifyIr = discoverIr(options.projectRoot, schemaDirectory, NOTIFY_FILENAME, discoverNotifyChannels);
    // An unreadable `lunora/notify.ts` still declares notify: report both channels so
    // their secrets are scaffolded and preflighted rather than silently dropped.
    const notifyChannels = notifyIr.error === undefined ? notifyIr.value : { hasFcm: true, hasWebPush: true };
    const flagshipBinding = flags?.provider === "flagship" && flags.mode === "binding" ? flags.bindingName : undefined;

    const generatedRoot = join(options.projectRoot, schemaDirectory, GENERATED_DIRECTORY);
    const hostsRegistry = hostsShardRegistry(durableObjects, generatedRoot);
    const hostsLog = hostsEventLog(entry);
    const entryUsesClient = !entry.composed && entry.path !== undefined && entryConstructsEventLogClient(entry.path, scannedFiles, generatedRoot);

    const signals = describeSignals(durableObjects, schema, capabilities, containers, workflows, agents);

    // A hand-written entry opts in by exporting `LunoraDO` itself; with the merge
    // module written and no such export, `durableObjects.merge` changed nothing.
    if (
        !entry.composed &&
        isMergedProject(join(options.projectRoot, schemaDirectory, GENERATED_DIRECTORY)) &&
        !durableObjects.some((object) => object.className === "LunoraDO")
    ) {
        signals.push(
            "hint: durableObjects.merge is set, but the worker entry exports no LunoraDO — export one built with mergeDurableObjects, or the classes stay separate",
        );
    }

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
        // The scanned flags first: `needsD1` below replaces the raw `env.DB` flag
        // with the schema-augmented value computed above.
        ...capabilities,
        usesEventLogClient: capabilities.usesEventLogClient || entryUsesClient,
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
        usesNotifyFcm: notifyChannels?.hasFcm ?? false,
        usesNotifyWebPush: notifyChannels?.hasWebPush ?? false,
        hostsEventLog: hostsLog,
        hostsShardRegistry: hostsRegistry,
        workflows,
    };
};

/**
 * The secret sources a project uses — the {@link PACKAGE_SECRETS_REGISTRY} keys
 * whose secrets it needs, derived from its already-resolved {@link InferredBindings}.
 *
 * This is the canonical bridge between binding inference and the
 * `.dev.vars.example` scaffolding in `scaffold-dev-variables.ts`. The result is
 * {@link FLAG_PACKAGES}' sources whose flag is `true` in `bindings` — in
 * flag-name order — followed by the configured `@lunora/notify` channels
 * ({@link SECRET_SOURCE_FLAGS}), keeping only sources that carry secrets.
 */
const secretSourcesFromBindings = (bindings: InferredBindings): string[] =>
    [...FLAG_PACKAGES, ...SECRET_SOURCE_FLAGS]
        .filter(([flag, source]) => bindings[flag] && PACKAGE_SECRETS_REGISTRY[source] !== undefined)
        .map(([, source]) => source);

export type { InferOptions, InferredAgent, InferredBindings, InferredContainer, InferredQueue, InferredWorkflow };
export { inferLunoraBindings, secretSourcesFromBindings };
