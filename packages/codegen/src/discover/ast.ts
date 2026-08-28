import { lstatSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { CallExpression, Expression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import { isServerSurfaceModule } from "../module-specifiers";

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE: RegExp = /\.ts$/u;

/** Lunora-relative module path for a source file: dir-relative, POSIX separators, no `.ts`. */
const lunoraRelativePath = (lunoraDirectory: string, filePath: string): string =>
    relative(lunoraDirectory, filePath).split(sep).join("/").replace(TS_EXTENSION_RE, "");

/**
 * Recursively collect `.ts` files under a lunora source directory, skipping
 * `_generated/`, `node_modules/`, and `schema.ts`. Shared by function and
 * migration discovery so both walk the same file set.
 *
 * Uses `lstatSync` (never `statSync`) so symlinked entries are classified by the
 * link itself, not its target: a directory symlink pointing at an ancestor (e.g.
 * `lunora/loop -> ..`) is therefore not descended into, breaking the symlink-cycle
 * infinite-recursion / build-hang that `statSync` (which follows links) would hit.
 */
const listLunoraSourceFiles = (directory: string, accumulator: string[] = [], root: string = directory): string[] => {
    let entries: string[];

    try {
        entries = readdirSync(directory);
    } catch {
        return accumulator;
    }

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = lstatSync(full);

        if (info.isDirectory()) {
            if (entry === "_generated" || entry === "node_modules") {
                continue;
            }

            listLunoraSourceFiles(full, accumulator, root);
        } else if (info.isFile() && extname(entry) === ".ts") {
            // Skip ONLY the top-level `lunora/schema.ts` — it is loaded separately
            // by `discoverSchema`. A nested `lunora/<feature>/schema.ts` is an
            // ordinary source file that can carry query/mutation/migration
            // registrations, so it must be discovered (the `directory === root`
            // guard fires at depth 0 only, where `directory` is the passed root).
            if (entry === "schema.ts" && directory === root) {
                continue;
            }

            accumulator.push(full);
        }
    }

    return accumulator;
};

/**
 * Shared driver for the per-call-site feeders: walk every lunora source file
 * (via {@link listLunoraSourceFiles}), resolve each into the shared `Project`
 * (reusing an already-added `SourceFile`), and map every `CallExpression`
 * descendant through `rowOf` with the file's lunora-relative path — rows kept
 * in encounter order.
 */
const collectCallRows = <Row>(project: Project, lunoraDirectory: string, rowOf: (call: CallExpression, relativePath: string) => Row | undefined): Row[] => {
    const rows: Row[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const row = rowOf(call, relativePath);

            if (row !== undefined) {
                rows.push(row);
            }
        }
    }

    return rows;
};

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
    if ((Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db")) {
        const first = call.getArguments()[0];

        return { options: call.getArguments()[1], table: first && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = (Node.isPropertyAccessExpression(inner) && inner.getName() === "db") || (Node.isIdentifier(inner) && inner.getText() === "db");

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

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
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

/**
 * Local names an import binds for `exportedName` in a source file.
 *
 * Purely syntactic — no `getSymbol()`, no type checker. Deliberate on two
 * counts: these detectors have to keep working under degraded type info (their
 * whole reason for matching by name), and they run on every `.use(...)`
 * argument of every chain, where resolving a symbol per callee is real
 * type-checker work on a hot path. Scanning a file's import declarations is a
 * handful of syntactic children by comparison.
 *
 * Deliberately NOT cached per source file. ts-morph reuses the `SourceFile`
 * object when a file is overwritten or refreshed, so a cache keyed on it serves
 * the previous content's aliases — which is a wrong answer about whether a
 * procedure declares a policy, traded for a saving this scan does not need.
 */
const importAliases = (sourceFile: SourceFile, exportedName: string): Set<string> => {
    const aliases = new Set<string>();

    for (const declaration of sourceFile.getImportDeclarations()) {
        if (!isServerSurfaceModule(declaration.getModuleSpecifierValue())) {
            continue;
        }

        for (const specifier of declaration.getNamedImports()) {
            if (specifier.getNameNode().getText() === exportedName) {
                aliases.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
            }
        }
    }

    return aliases;
};

/**
 * True when a call's `callee` names `expectedName` — literally, or through an
 * import alias.
 *
 * The middleware detectors (`isRlsCall`, `isMaskCall`) match by NAME rather than
 * by import origin on purpose: it keeps them working when ts-morph has degraded
 * type info, where an origin check resolves to nothing and would drop every
 * policy. The plain text comparison alone missed `import { rls as rowLevel }`
 * though, so an aliased import read as unrelated middleware — `usesRls: false`,
 * no policies in the inspector, and the dispatch lint suppressed for that
 * target. The asymmetry made it worse: `classifyProcedureCall` DOES resolve
 * aliases, so the same file's procedure classified correctly while its policy
 * evidence vanished.
 *
 * The alias hop is additive: the text match still answers first, so degraded
 * type info behaves exactly as before. It does gate on the module specifier,
 * unlike the text match — these signals SUPPRESS lints as well as enable them
 * (`usesRls` short-circuits `rls-uncovered-table` and
 * `normalize-id-used-as-authorization`), so trusting an unrelated library's
 * `rls` would silence a real finding. The text match's own false positives are
 * pre-existing and left alone; this hop does not add to them.
 */
const resolvesToImportedName = (callee: Node, expectedName: string): boolean => {
    if (Node.isPropertyAccessExpression(callee)) {
        return callee.getName() === expectedName;
    }

    if (!Node.isIdentifier(callee)) {
        return false;
    }

    const text = callee.getText();

    return text === expectedName || importAliases(callee.getSourceFile(), expectedName).has(text);
};

/** One `.method(...)` step of a builder chain, in terminal-to-root order. */
interface BuilderChainStep {
    /** The step call itself — `.use(rls(p))`, `.input({...})`, `.output(v)`. */
    call: CallExpression;
    /** The step's method name. */
    name: string;
}

/**
 * Walk a builder chain leftward from `receiver`, collecting each `.method(...)`
 * step and the expression the chain bottoms out at.
 *
 * This walk was written out longhand in eight places, in three dialects that
 * disagreed about whether to unwrap `(x)` / `x as T` and about what a
 * non-property-access callee means — so a cast mid-chain was invisible to some
 * callers and fatal to others, and a fix applied to one dialect left the rest
 * drifting. One walk, one unwrapping policy, one termination policy.
 *
 * Steps come back TERMINAL-FIRST (the order the chain reads leftward), which is
 * what the "last one written wins" rules downstream depend on: the first
 * `.output()` seen is the last one authored.
 *
 * `root` is the non-call expression the chain ends at, or `undefined` when a
 * step's callee was not a property access. Collapsing those two cases is safe —
 * every caller only ever asks whether `root` is a specific identifier, and a
 * half-walked chain never yields one.
 */
const walkBuilderChain = (receiver: Node): { root: Node | undefined; steps: BuilderChainStep[] } => {
    const steps: BuilderChainStep[] = [];
    let current: Node | undefined = unwrapExpression(receiver);

    while (current && Node.isCallExpression(current)) {
        const callee = unwrapExpression(current.getExpression());

        if (!callee || !Node.isPropertyAccessExpression(callee)) {
            return { root: undefined, steps };
        }

        steps.push({ call: current, name: callee.getName() });
        current = unwrapExpression(callee.getExpression());
    }

    return { root: current, steps };
};

/** The `.method(...)` steps of a builder chain, terminal-first. */
const builderChainSteps = (receiver: Node): BuilderChainStep[] => walkBuilderChain(receiver).steps;

/**
 * The first argument of every `<method>(<callee>(...))` step in the chain — the
 * shape `.use(rls(...))` / `.use(mask(...))` take. `callee` is matched through
 * {@link resolvesToImportedName}, so an import alias counts.
 */
const wrappedCallsInChain = (receiver: Node, method: string, callee: string): CallExpression[] =>
    builderChainSteps(receiver)
        .filter((step) => step.name === method)
        .map((step) => step.call.getArguments()[0])
        .filter(
            (argument): argument is CallExpression =>
                argument !== undefined && Node.isCallExpression(argument) && resolvesToImportedName(argument.getExpression(), callee),
        );

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
    builderChainSteps,
    collectCallRows,
    defaultExportExpression,
    enclosingExportName,
    handlerOf,
    isContextIdentifier,
    isDatabaseCall,
    limitNameOf,
    listLunoraSourceFiles,
    lunoraRelativePath,
    propertyInitializer,
    readTargetOf,
    resolvesToImportedName,
    stringPropertyFor,
    stringPropertyOf,
    tableArgumentOf,
    tablesAccessedIn,
    TS_EXTENSION_RE,
    unwrapExpression,
    unwrapToCallExpression,
    walkBuilderChain,
    wrappedCallsInChain,
};
