/**
 * The export-graph walk behind the relay-secret inference: whether a worker hosts `EventLogDO` or constructs `EventLogDOClient`,
 * followed through re-exports, value aliases, namespace properties, exported subclasses, tsconfig path aliases, and shadowing by
 * local exports. Each branch exists because a project reached the class that way and was told the wrong secret.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { BindingElement, CallExpression, Identifier, SourceFile } from "ts-morph";
import { Node, ts } from "ts-morph";

import join from "./path";

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

/** A file's modification time, or `-1` when it is missing, which never matches a cached entry. */
const mtimeOf = (file: string): number => (ts.sys.fileExists(file) ? statSync(file).mtimeMs : -1);

/**
 * Parsed tsconfig options by config path. An entry holds while the config and every file it extends keep their modification
 * times, so editing a base config's `paths` reaches a long-running process.
 */
const parsedCompilerOptions = new Map<string, { mtimes: Map<string, number>; options: ts.CompilerOptions }>();

/** The compiler options of the nearest tsconfig.json, read the way TypeScript reads them. Empty when the project has none. */
const compilerOptionsFor = (fromFile: string): ts.CompilerOptions => {
    const configPath = ts.findConfigFile(dirname(fromFile), (path) => ts.sys.fileExists(path));

    if (configPath === undefined) {
        return {};
    }

    const cached = parsedCompilerOptions.get(configPath);

    if (cached !== undefined && [...cached.mtimes].every(([file, mtimeMs]) => mtimeOf(file) === mtimeMs)) {
        return cached.options;
    }

    const sourceFile = ts.readJsonConfigFile(configPath, (path) => ts.sys.readFile(path));
    const { options } = ts.parseJsonSourceFileConfigFileContent(sourceFile, ts.sys, dirname(configPath));
    const mtimes = new Map([configPath, ...(sourceFile.extendedSourceFiles ?? [])].map((file) => [file, mtimeOf(file)]));

    parsedCompilerOptions.set(configPath, { mtimes, options });

    return options;
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

export { constructsEventLogClient, EVENT_LOG_CLIENT, EVENT_LOG_PACKAGE, forwardsReplicaExport, parseModule, resolveBarrel, runtimeSpecifiersOf };
