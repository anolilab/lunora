import type { Stats } from "node:fs";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

import type { CallExpression, Expression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE: RegExp = /\.ts$/u;

/** Lunora-relative module path for a source file: dir-relative, POSIX separators, no `.ts`. */
const lunoraRelativePath = (lunoraDirectory: string, filePath: string): string =>
    relative(lunoraDirectory, filePath).split(sep).join("/").replace(TS_EXTENSION_RE, "");

/** Directories under `lunora/` that are never source: codegen's own output, and installed packages. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["_generated", "node_modules"]);

/**
 * The top-level `lunora/schema.ts` ONLY — `discoverSchema` loads that one
 * separately. A nested `lunora/<feature>/schema.ts` is an ordinary source file
 * that can carry query/mutation/migration registrations, so it must still be
 * discovered; the `directory === root` test is what keeps this to depth 0.
 */
const isRootSchemaFile = (entry: string, directory: string, root: string): boolean => entry === "schema.ts" && directory === root;

/**
 * `statSync` an entry (following symlinks), reporting `undefined` for one that
 * does not resolve — a dangling link, or a file that vanished mid-walk. Silence
 * is what makes a mis-pointed link read as an empty directory, so the skip is
 * said out loud; discovery has no diagnostic sink to route it through.
 */
const statOrReport = (path: string): Stats | undefined => {
    try {
        return statSync(path);
    } catch {
        // eslint-disable-next-line no-console -- matches the other skip warnings in this package; there is no diagnostic sink here.
        console.warn(`@lunora/codegen: skipping ${path} — it is a symlink that does not resolve (or vanished mid-scan).`);

        return undefined;
    }
};

/**
 * Recursively collect `.ts` files under a lunora source directory, skipping
 * `_generated/`, `node_modules/`, and `schema.ts`. Shared by function and
 * migration discovery so both walk the same file set.
 *
 * Symlinks are FOLLOWED (`statSync`, not `lstatSync`): a symlinked file or
 * directory under `lunora/` is ordinary source a team may well share that way,
 * and classifying it by the link itself made it neither `isFile()` nor
 * `isDirectory()`, so it was dropped from discovery in silence — the functions
 * in it were never registered while the dev watcher still fired on every save.
 * A link that resolves nowhere is reported rather than dropped.
 *
 * Following links reintroduces the cycle a link to an ancestor (`lunora/loop ->
 * ..`) creates, so every directory is visited once by its REAL path: the second
 * arrival at the same target ends that branch instead of recursing forever.
 */
const listLunoraSourceFiles = (directory: string, accumulator: string[] = [], root: string = directory, visited: Set<string> = new Set()): string[] => {
    let entries: string[];
    let realDirectory: string;

    try {
        entries = readdirSync(directory);
        realDirectory = realpathSync(directory);
    } catch {
        return accumulator;
    }

    // Cycle guard: one visit per REAL directory, so a link back to an ancestor
    // (`lunora/loop -> .`) ends here instead of walking the tree again — or
    // forever.
    if (visited.has(realDirectory)) {
        return accumulator;
    }

    visited.add(realDirectory);

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = statOrReport(full);

        if (info === undefined) {
            continue;
        }

        if (info.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry)) {
                listLunoraSourceFiles(full, accumulator, root, visited);
            }
        } else if (info.isFile() && extname(entry) === ".ts" && !isRootSchemaFile(entry, directory, root)) {
            accumulator.push(full);
        }
    }

    return accumulator;
};

/**
 * Where the worker entry lives, probed relative to the project root when a
 * security discoverer widens its scan past `lunora/`.
 *
 * Deliberately NOT the same list as `@lunora/config`'s
 * `WORKER_ENTRY_FALLBACKS`, and not a copy of it: that one picks THE entry file
 * when `wrangler.main` is absent, so it names exact paths
 * (`src/server/index.ts`, `.tsx`). This one decides which files a security lint
 * gets to see, so it takes `src/server` as a whole directory — the entry
 * routinely splits `createBrowser`/`createPayment` wiring into helpers beside
 * itself, and a lint that missed those would report clean on a real defect.
 */
const WORKER_ENTRY_ROOTS = ["src/server", "src/index.ts", "src/worker.ts"] as const;

/** Source extensions the worker-entry probe accepts — a `.tsx` entry is one of `@lunora/config`'s fallbacks. */
const ENTRY_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Collect source files at `path`, which may be a single file or a directory to
 * recurse. Anything that is neither (a missing path, a symlink — `lstatSync`
 * classifies by the link, so a directory symlink is never descended into) is
 * skipped.
 */
const listEntrySourceFiles = (path: string, accumulator: string[] = []): string[] => {
    let info;

    try {
        info = lstatSync(path);
    } catch {
        return accumulator;
    }

    if (info.isFile()) {
        if (ENTRY_EXTENSIONS.has(extname(path))) {
            accumulator.push(path);
        }

        return accumulator;
    }

    if (!info.isDirectory()) {
        return accumulator;
    }

    for (const entry of readdirSync(path)) {
        if (entry === "_generated" || entry === "node_modules") {
            continue;
        }

        listEntrySourceFiles(join(path, entry), accumulator);
    }

    return accumulator;
};

/** One file a security discoverer scans: where to parse it from, and how a finding names it. */
interface ScannedSourceFile {
    /** How a finding refers to the file — project-relative, POSIX separators, no extension. */
    displayPath: string;
    /** Absolute path to parse. */
    filePath: string;
}

/**
 * The file set the *security* discoverers scan: the `lunora/` tree plus the
 * worker entry (`src/server/**`, `src/index.ts`, `src/worker.ts`).
 *
 * The worker-entry factories those lints inspect — `createInboundEmailHandler`,
 * `createPayment`, `createBrowser`, the CDC export sinks — are constructed in the
 * entry by convention and never under `lunora/`, so a `lunora/`-only walk saw
 * zero call sites and five ERROR-level lints could not fire at all.
 *
 * Deliberately a second, explicitly-scoped walk rather than a widening of
 * {@link listLunoraSourceFiles}: that set is the *function* file set — every other
 * discoverer, plus `refreshCodegenProject`'s add/remove reconciliation, depends on
 * it staying exactly `lunora/`.
 *
 * The project root is `dirname(lunoraDirectory)`, which is how `runCodegen` builds
 * the lunora directory in the first place.
 */
const listSecurityScanFiles = (lunoraDirectory: string): ScannedSourceFile[] => {
    const projectRoot = dirname(lunoraDirectory);
    const files: ScannedSourceFile[] = listLunoraSourceFiles(lunoraDirectory).map((filePath) => {
        return { displayPath: lunoraRelativePath(lunoraDirectory, filePath), filePath };
    });
    const seen = new Set(files.map((file) => file.filePath));

    for (const root of WORKER_ENTRY_ROOTS) {
        for (const filePath of listEntrySourceFiles(join(projectRoot, root))) {
            if (seen.has(filePath)) {
                continue;
            }

            seen.add(filePath);
            files.push({ displayPath: lunoraRelativePath(projectRoot, filePath), filePath });
        }
    }

    return files;
};

/**
 * Resolve each file into the shared `Project` (reusing an already-added
 * `SourceFile`) and map every `CallExpression` descendant through `rowOf` with
 * the file's display path — rows kept in encounter order.
 *
 * The file set is the caller's choice: {@link collectCallRows} passes the
 * function file set, {@link collectSecurityCallRows} the wider security one.
 */
const collectRowsFrom = <Row>(project: Project, files: ScannedSourceFile[], rowOf: (call: CallExpression, relativePath: string) => Row | undefined): Row[] => {
    const rows: Row[] = [];

    for (const { displayPath, filePath } of files) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const row = rowOf(call, displayPath);

            if (row !== undefined) {
                rows.push(row);
            }
        }
    }

    return rows;
};

/**
 * Shared driver for the per-call-site feeders: walk every lunora source file
 * (via {@link listLunoraSourceFiles}) and map every `CallExpression` descendant
 * through `rowOf` with the file's lunora-relative path.
 */
const collectCallRows = <Row>(project: Project, lunoraDirectory: string, rowOf: (call: CallExpression, relativePath: string) => Row | undefined): Row[] =>
    collectRowsFrom(
        project,
        listLunoraSourceFiles(lunoraDirectory).map((filePath) => {
            return { displayPath: lunoraRelativePath(lunoraDirectory, filePath), filePath };
        }),
        rowOf,
    );

/**
 * The {@link collectCallRows} driver over the *security* file set — `lunora/`
 * plus the worker entry (see {@link listSecurityScanFiles}) — for a feeder
 * whose call sites are conventionally built in the entry, not under `lunora/`.
 */
const collectSecurityCallRows = <Row>(
    project: Project,
    lunoraDirectory: string,
    rowOf: (call: CallExpression, relativePath: string) => Row | undefined,
): Row[] => collectRowsFrom(project, listSecurityScanFiles(lunoraDirectory), rowOf);

/**
 * Export binding name of the exported, top-level function that lexically contains
 * the call (e.g. `export const send = mutation({ … })` → `"send"`), or `""` when
 * the call isn't inside an exported declaration. Walks out past any local
 * `const x = …` declarations to the exported one.
 *
 * Shared by the call-attribution discoverers (`discover/inserts`,
 * `discover/authapi-calls`, `discover/workflow-calls`). The
 * `discover/sql-interpolation` variant has divergent semantics (no export-keyword
 * check, `"<module>"` fallback) and is intentionally NOT this helper.
 */
const enclosingExportName = (call: CallExpression): string => {
    for (const ancestor of call.getAncestors()) {
        if (Node.isVariableDeclaration(ancestor) && ancestor.getVariableStatement()?.hasExportKeyword() === true) {
            return ancestor.getName();
        }
    }

    return "";
};

/**
 * The handler function of a query/mutation registration — its terminal-builder
 * argument or the `handler:` property of the bare-factory object literal.
 * Returns `undefined` when the handler isn't a statically recognisable function
 * expression (so we under-report rather than scan an unrelated node).
 */
const handlerOf = (call: CallExpression, receiver: Node | undefined): Node | undefined => {
    // Builder terminal: the handler is the terminal call's first argument.
    if (receiver) {
        const handler = call.getArguments()[0];

        return handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) ? handler : undefined;
    }

    // Bare factory: pull the `handler:` property off the first object-literal argument.
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return undefined;
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return undefined;
    }

    const initializer = handlerProperty.getInitializer();

    return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) ? initializer : undefined;
};

/**
 * The initializer of a named property on an object-literal `object`, when
 * `object` is itself a statically-readable object literal and the property is a
 * plain (non-spread, non-shorthand) `PropertyAssignment`. `undefined` in every
 * other case — a missing key, a spread-only/opaque parent, or a shorthand/method
 * property with no useful initializer to read.
 */
const propertyInitializer = (object: Node | undefined, name: string): Node | undefined => {
    if (!object || !Node.isObjectLiteralExpression(object)) {
        return undefined;
    }

    const property = object.getProperty(name);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

/** True when `receiver` is the database accessor: `ctx.db` (property named `db`) or a bare `db`. */
const isDatabaseAccessor = (receiver: Node): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db");

/**
 * List reads whose options object the `ctx.db` read feeders inspect. Only
 * `findMany` / `findFirst` / `findFirstOrThrow` take an options object — the
 * by-id `get` is id-only and the fluent `query(...)` reader carries no options
 * object, so both are excluded.
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany"]);

/**
 * The `(table, options)` a `ctx.db` list read addresses, or `undefined` when the
 * call isn't one. Matched by receiver **shape** (not import origin), fail-closed,
 * in both surface forms Lunora exposes. Facade form
 * `ctx.db.<table>.findMany(options?)` — the form real app code writes — puts the
 * table in the receiver's property name and the options object at argument 0.
 * Table-arg form `ctx.db.findMany("table", options?)` puts the table in the
 * string-literal argument 0 and the options object at argument 1. `table` is `""`
 * when the table-arg form's first argument isn't a string literal (a dynamic
 * table — not lintable).
 */
const readTargetOf = (call: CallExpression): { options: Node | undefined; table: string } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !READ_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    // Table-arg form: the receiver is `ctx.db` (property named `db`) or a bare `db`.
    if (isDatabaseAccessor(receiver)) {
        const first = call.getArguments()[0];

        return { options: call.getArguments()[1], table: first && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = isDatabaseAccessor(inner);

        if (onDatabase) {
            return { options: call.getArguments()[0], table: receiver.getName() };
        }
    }

    return undefined;
};

/** True when `call` is a `ctx.db.<method>(...)` or bare `db.<method>(...)` call against `methodSet`. */
const isDatabaseCall = (call: CallExpression, methodSet: ReadonlySet<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    return isDatabaseAccessor(callee.getExpression());
};

/** String-literal first argument of a `ctx.db.<method>("table", ...)` call, or `""` when the argument is not a string literal (dynamic table — not lintable). */
const tableArgumentOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover the set of tables read and written inside the lexical scope of the
 * exported procedure binding (including helper closures in the body), against
 * the caller's read/write method sets.
 */
const tablesAccessedIn = (
    declaration: Node,
    readMethods: ReadonlySet<string>,
    writeMethods: ReadonlySet<string>,
): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDatabaseCall(call, readMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDatabaseCall(call, writeMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

/**
 * Strip the type-level and grouping wrappers an expression may be dressed in —
 * `(x)`, `x as T`, `x satisfies T`, `x!` — down to the expression itself.
 *
 * Builder chains are walked structurally, so a wrapper anywhere along one used
 * to end the walk early: `(c.use(rls(p)) as QueryBuilder).query(h)` failed to
 * classify as a procedure at all, dropping the whole function from
 * `LUNORA_FUNCTIONS` while codegen still exited `ok`. None of these wrappers
 * change what the expression evaluates to, so none of them should change what
 * discovery sees.
 */
const unwrapExpression = (node: Node | undefined): Node | undefined => {
    let current: Node | undefined = node;

    while (
        current &&
        (Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current))
    ) {
        current = current.getExpression();
    }

    return current;
};

/**
 * Unwrap `as`/`satisfies`/parenthesized wrappers around a call expression —
 * `define…({...}) satisfies Definition`, `define…({...}) as const`, or
 * `(define…({...}))` — down to the inner `CallExpression`. Returns `undefined`
 * when the (possibly wrapped) node isn't ultimately a call.
 */
const unwrapToCallExpression = (node: Node | undefined): CallExpression | undefined => {
    const current = unwrapExpression(node);

    return current && Node.isCallExpression(current) ? current : undefined;
};

/** Resolve the `export default` expression, following one `const x = …; export default x` indirection. */
const defaultExportExpression = (source: SourceFile): Expression | undefined => {
    const assignment = source.getExportAssignment((declaration) => !declaration.isExportEquals());

    if (!assignment) {
        return undefined;
    }

    const expression = assignment.getExpression();

    if (!Node.isIdentifier(expression)) {
        return expression;
    }

    const declaration = expression.getSymbol()?.getValueDeclaration();

    if (declaration && Node.isVariableDeclaration(declaration)) {
        return declaration.getInitializer();
    }

    return expression;
};

/** The string-literal value of a call's second (`name`) argument, or `""` when it isn't one. */
const limitNameOf = (call: CallExpression): string => {
    const argument = call.getArguments()[1];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : "";
};

/** Read a string-literal property from an object literal, or `undefined` when absent/non-literal. */
const stringPropertyOf = (object: Node, name: string): string | undefined => {
    if (!Node.isObjectLiteralExpression(object)) {
        return undefined;
    }

    const property = object.getProperty(name);

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralText() : undefined;
};

/** True when `node` is the literal `ctx` identifier — the anchor a `ctx.flags.*` read starts from. */
const isContextIdentifier = (node: Node): boolean => Node.isIdentifier(node) && node.getText() === "ctx";

/**
 * Build the deploy-config string reader for one registry noun (`agent` /
 * `container` / `queue` / `workflow`): read a property's string-literal value,
 * or throw a located diagnostic naming that noun.
 */
const stringPropertyFor =
    (noun: string) =>
    (expression: Expression, exportName: string, property: string): string => {
        if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
            return expression.getLiteralValue();
        }

        throw diagnosticAt(
            expression,
            `${noun} "${exportName}": \`${property}\` must be a static string literal — it is deploy configuration codegen writes into wrangler.jsonc`,
        );
    };

export {
    collectCallRows,
    collectSecurityCallRows,
    defaultExportExpression,
    enclosingExportName,
    handlerOf,
    isContextIdentifier,
    isDatabaseAccessor,
    limitNameOf,
    listLunoraSourceFiles,
    listSecurityScanFiles,
    lunoraRelativePath,
    propertyInitializer,
    readTargetOf,
    stringPropertyFor,
    stringPropertyOf,
    tableArgumentOf,
    tablesAccessedIn,
    TS_EXTENSION_RE,
    unwrapExpression,
    unwrapToCallExpression,
};
export type { ScannedSourceFile };
