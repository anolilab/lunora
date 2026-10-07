import type { Stats } from "node:fs";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { FIND_UP_STOP, findUpSync, matcher } from "@visulima/fs";
import type {
    BindingElement,
    Block,
    CallExpression,
    Expression,
    Identifier,
    KindToNodeMappings,
    ObjectLiteralElementLike,
    ObjectLiteralExpression,
    Project,
    SourceFile,
    Symbol as TsSymbol,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import { readProjectConfigLiterals } from "../project-config-file";
import { findProjectConfigFile } from "../project-config-path";
import { propertyKeyName, propertyNameText } from "./property-name";

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE: RegExp = /\.ts$/u;

/** Lunora-relative module path for a source file: dir-relative, POSIX separators, no `.ts`. */
const lunoraRelativePath = (lunoraDirectory: string, filePath: string): string =>
    relative(lunoraDirectory, filePath).split(sep).join("/").replace(TS_EXTENSION_RE, "");

/** Directories under `lunora/` that are never source: codegen's own output, and installed packages. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["_generated", "node_modules"]);

/**
 * The test / mock / fixture folders. Only the dunder names: a plain `test/` or
 * `tests/` may be a real feature module, and skipping it would drop its
 * functions in silence — a project adds those through `codegen.exclude`.
 */
const TEST_DIRECTORIES: ReadonlySet<string> = new Set(["__fixtures__", "__mocks__", "__snapshots__", "__tests__"]);

/**
 * A test file name by its common suffix (`x.test.ts`, `x.spec.ts`,
 * `x.test-d.ts`, `x.bench.ts`, `x.e2e-spec.ts`, …). No prefix rule: a
 * `test-drive.ts` is as likely a real module as a helper. The extension is
 * optional so a lunora-relative module path (`chat/x.test`) matches too.
 */
const TEST_FILE_RE: RegExp = /\.(?:bench|e2e|e2e-spec|spec|spec-d|test|test-d)(?:\.tsx?)?$/u;

/**
 * Whether `relativePath` (POSIX separators, with or without its extension) is
 * test code: a test file name, or anything under a test folder. Tests seed
 * tables across module boundaries and call functions from module scope by
 * design, so discovery skips them — they would bury real advisories and
 * architecture gaps under fixture noise. Secret discovery is the one reader
 * that keeps them (see `listLunoraSourceFiles`), and uses this to tell a
 * fixture apart.
 */
const isTestPath = (relativePath: string): boolean => {
    const segments = relativePath.split("/");

    return TEST_FILE_RE.test(segments.at(-1) ?? "") || segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
};

/**
 * Whether a walk skips `entry` (a bare name): codegen's own output and installed
 * packages always, test folders and files unless the walk keeps tests.
 */
const isSkippedEntry = (entry: string, isDirectory: boolean, includeTests: boolean): boolean =>
    isDirectory ? SKIPPED_DIRECTORIES.has(entry) || (!includeTests && TEST_DIRECTORIES.has(entry)) : !includeTests && TEST_FILE_RE.test(entry);

/** The compiled `codegen.exclude` matcher per config file, keyed on mtime + size so an edit is picked up. */
const excludeCache = new Map<string, { isExcluded: (relativePath: string) => boolean; key: string }>();

const NOTHING_EXCLUDED = (): boolean => false;

/**
 * The `codegen.exclude` globs of the `lunora.config.*` nearest above
 * `lunoraDirectory` (stopping at the project's `package.json`), compiled to a
 * matcher. Every discoverer walks the source tree, so the config is parsed once
 * per edit rather than once per walk — and an unreadable value is reported once,
 * never silently treated as "no excludes" without a word.
 */
const configuredExcludes = (lunoraDirectory: string): ((relativePath: string) => boolean) => {
    // The project root (its `package.json`, or the repo root) ends the search: a
    // config above it belongs to another project.
    const configFile = findUpSync(
        (directory) =>
            findProjectConfigFile(directory) ?? (existsSync(join(directory, "package.json")) || existsSync(join(directory, ".git")) ? FIND_UP_STOP : undefined),
        {
            cwd: dirname(resolve(lunoraDirectory)),
        },
    );
    const stats = configFile === undefined ? undefined : statSync(configFile, { throwIfNoEntry: false });

    if (configFile === undefined || stats === undefined) {
        return NOTHING_EXCLUDED;
    }

    const key = `${String(stats.mtimeMs)}:${String(stats.size)}`;
    const cached = excludeCache.get(configFile);

    if (cached?.key === key) {
        return cached.isExcluded;
    }

    const { codegen } = readProjectConfigLiterals(dirname(configFile));

    if (codegen?.unreadable) {
        // eslint-disable-next-line no-console -- matches the other skip warnings in this package; there is no diagnostic sink here.
        console.warn("@lunora/codegen: `codegen.exclude` in lunora.config is not an array of string literals without `!` negations — ignoring it.");
    }

    const isExcluded = codegen?.exclude?.length ? matcher(codegen.exclude) : NOTHING_EXCLUDED;

    excludeCache.set(configFile, { isExcluded, key });

    return isExcluded;
};

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
 * {@link SKIPPED_DIRECTORIES}, test files, `codegen.exclude` globs, and the root
 * `schema.ts`. Shared by function and migration discovery so both walk the same
 * file set.
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
const walkLunoraSourceFiles = (
    directory: string,
    accumulator: string[],
    root: string,
    visited: Set<string>,
    isSkipped: (entry: string, relativePath: string, isDirectory: boolean) => boolean,
): string[] => {
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

        if (info === undefined || isSkipped(entry, relative(root, full).split(sep).join("/"), info.isDirectory())) {
            continue;
        }

        if (info.isDirectory()) {
            walkLunoraSourceFiles(full, accumulator, root, visited, isSkipped);
        } else if (info.isFile() && extname(entry) === ".ts" && !isRootSchemaFile(entry, directory, root)) {
            accumulator.push(full);
        }
    }

    return accumulator;
};

/**
 * The exported entry point: every discoverer calls this with a directory. Only
 * the readers that must see every file opt into `includeSkipped` — test files
 * and `codegen.exclude` matches included: secret discovery, because a vendor key
 * committed anywhere is still a leak, and the watcher fingerprint that decides
 * when that scan reruns. {@link walkLunoraSourceFiles}'s
 * accumulator/root/visited stay unexported because they are recursion state — a
 * caller passing a pre-filled accumulator or a stale `visited` silently changes
 * which files are discovered, and an exported signature freezes that hazard into
 * the public API snapshot.
 */
const listLunoraSourceFiles = (directory: string, options: { includeSkipped?: boolean } = {}): string[] => {
    const includeSkipped = options.includeSkipped ?? false;
    const isExcluded = includeSkipped ? NOTHING_EXCLUDED : configuredExcludes(directory);

    return walkLunoraSourceFiles(
        directory,
        [],
        directory,
        new Set(),
        (entry, relativePath, isDirectory) => isSkippedEntry(entry, isDirectory, includeSkipped) || isExcluded(relativePath),
    );
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
        if (ENTRY_EXTENSIONS.has(extname(path)) && !isSkippedEntry(basename(path), false, false)) {
            accumulator.push(path);
        }

        return accumulator;
    }

    if (!info.isDirectory()) {
        return accumulator;
    }

    for (const entry of readdirSync(path)) {
        // Files are judged on arrival above; a directory is pruned here by name.
        if (isSkippedEntry(entry, true, false)) {
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
 * worker entry (`src/server/**`, `src/index.ts`, `src/worker.ts`) and the root
 * `lunora.config.*`, whose `app` hook configures the same worker.
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

    // The root `lunora.config.*` too: `@lunora/vite` imports it into the worker
    // and runs its `app` hook over the `defineApp()` builder, so an `.auth(…)`,
    // `.extend(…)` or factory call there configures the deployed worker exactly
    // as one in the entry does.
    const configFile = findProjectConfigFile(projectRoot);

    for (const filePath of [
        ...WORKER_ENTRY_ROOTS.flatMap((root) => listEntrySourceFiles(join(projectRoot, root))),
        ...(configFile === undefined ? [] : [configFile]),
    ]) {
        if (seen.has(filePath)) {
            continue;
        }

        seen.add(filePath);
        files.push({ displayPath: lunoraRelativePath(projectRoot, filePath), filePath });
    }

    return files;
};

/** What a row mapper yields for one node: nothing, one row, or several (a write naming two tables). */
type RowsOf<Row extends object> = ReadonlyArray<Row> | Row | undefined;

/** Narrows {@link RowsOf} to its several-rows case. */
const isRowList = <Row extends object>(rows: RowsOf<Row>): rows is ReadonlyArray<Row> => Array.isArray(rows);

/**
 * Resolve each file into the shared `Project` (reusing an already-added
 * `SourceFile`) and map every descendant of `kind` through `rowOf` with the
 * file's display path — rows kept in encounter order.
 */
const collectNodeRowsFrom = <Row extends object, Kind extends SyntaxKind>(
    project: Project,
    files: ReadonlyArray<ScannedSourceFile>,
    kind: Kind,
    rowOf: (node: KindToNodeMappings[Kind], relativePath: string) => RowsOf<Row>,
): Row[] => {
    const rows: Row[] = [];

    for (const { displayPath, filePath } of files) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const node of sourceFile.getDescendantsOfKind(kind)) {
            const produced = rowOf(node, displayPath);

            if (isRowList(produced)) {
                rows.push(...produced);
            } else if (produced !== undefined) {
                rows.push(produced);
            }
        }
    }

    return rows;
};

/** The lunora source files ({@link listLunoraSourceFiles}) with their lunora-relative display paths. */
const lunoraScanFiles = (lunoraDirectory: string): ScannedSourceFile[] =>
    listLunoraSourceFiles(lunoraDirectory).map((filePath) => {
        return { displayPath: lunoraRelativePath(lunoraDirectory, filePath), filePath };
    });

/**
 * Shared driver for the per-site feeders: walk every lunora source file (via
 * {@link listLunoraSourceFiles}) and map every descendant of `kind` through
 * `rowOf` with the file's lunora-relative path.
 */
const collectNodeRows = <Row extends object, Kind extends SyntaxKind>(
    project: Project,
    lunoraDirectory: string,
    kind: Kind,
    rowOf: (node: KindToNodeMappings[Kind], relativePath: string) => RowsOf<Row>,
): Row[] => collectNodeRowsFrom(project, lunoraScanFiles(lunoraDirectory), kind, rowOf);

/** The {@link collectNodeRows} walk over every `CallExpression` — what most feeders scan. */
const collectCallRows = <Row extends object>(
    project: Project,
    lunoraDirectory: string,
    rowOf: (call: CallExpression, relativePath: string) => RowsOf<Row>,
): Row[] => collectNodeRows(project, lunoraDirectory, SyntaxKind.CallExpression, rowOf);

/**
 * The {@link collectCallRows} driver over the *security* file set — `lunora/`
 * plus the worker entry (see {@link listSecurityScanFiles}) — for a feeder
 * whose call sites are conventionally built in the entry, not under `lunora/`.
 */
const collectSecurityCallRows = <Row extends object>(
    project: Project,
    lunoraDirectory: string,
    rowOf: (call: CallExpression, relativePath: string) => RowsOf<Row>,
): Row[] => collectNodeRowsFrom(project, listSecurityScanFiles(lunoraDirectory), SyntaxKind.CallExpression, rowOf);

/**
 * The property a destructuring element reads, quote-blind: `{ ctx }`,
 * `{ ctx: c }` and `{ "ctx": c }` all read `ctx`. The same root cause as
 * {@link propertyKeyName}, on the pattern side — `getPropertyNameNode().getText()`
 * keeps a string-literal key's quotes.
 */
const bindingKeyName = (element: BindingElement): string => propertyNameText(element.getPropertyNameNode() ?? element.getNameNode());

/**
 * The member of `object` whose runtime key is `name`, quoted or not — the
 * quote-blind replacement for ts-morph's `getProperty(name)`, which matches on
 * source text and so misses `{ "handler": … }`. Spreads have no key and never
 * match. `undefined` for an absent `object`.
 */
const findObjectProperty = (object: ObjectLiteralExpression | undefined, name: string): ObjectLiteralElementLike | undefined =>
    object?.getProperties().find((property) => !Node.isSpreadAssignment(property) && propertyKeyName(property) === name);

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

    const handlerProperty = findObjectProperty(first, "handler");

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

    const property = findObjectProperty(object, name);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

/** Whether `node` is a `const` variable declaration: the only binding that cannot be repointed after its initializer ran. */
const isConstDeclaration = (node: Node | undefined): node is VariableDeclaration => {
    const list = node?.getParent();

    return Node.isVariableDeclaration(node) && Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const;
};

/**
 * The outermost expression around `node` that still denotes the same value:
 * `(x)`, `x as T`, `x satisfies T`, `<T>x` and `x!` all evaluate to `x`.
 */
const outermostValueWrapper = (node: Node): Node => {
    let current = node;
    let parent = current.getParent();

    while (
        parent !== undefined &&
        (Node.isParenthesizedExpression(parent) ||
            Node.isAsExpression(parent) ||
            Node.isSatisfiesExpression(parent) ||
            Node.isTypeAssertion(parent) ||
            Node.isNonNullExpression(parent))
    ) {
        current = parent;
        parent = current.getParent();
    }

    return current;
};

/**
 * Whether the expression `node` is written to, seen through type-only and
 * parenthesis wrappers (`(x as T).k = v` writes `x.k`): the left of any
 * assignment operator, an `++` / `--` / `delete` operand, a `for…in` /
 * `for…of` target, or a slot inside a destructuring assignment's left side
 * (`({ userId } = other)`, `[x.k] = list`).
 */
const isWriteTarget = (node: Node): boolean => {
    const target = outermostValueWrapper(node);
    const parent = target.getParent();

    if (parent === undefined) {
        return false;
    }

    if (Node.isBinaryExpression(parent)) {
        const operator = parent.getOperatorToken().getKind();

        return parent.getLeft() === target && operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
    }

    if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
        const operator = parent.getOperatorToken();

        return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
    }

    if (Node.isDeleteExpression(parent)) {
        return true;
    }

    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) {
        return parent.getInitializer() === target;
    }

    if (Node.isPropertyAssignment(parent)) {
        const initializer: Node | undefined = parent.getInitializer();

        return initializer === target && isWriteTarget(parent);
    }

    // A slot of a destructuring assignment: the enclosing literal is the write target.
    const isSlot =
        Node.isShorthandPropertyAssignment(parent) ||
        Node.isSpreadAssignment(parent) ||
        Node.isSpreadElement(parent) ||
        Node.isObjectLiteralExpression(parent) ||
        Node.isArrayLiteralExpression(parent);

    return isSlot && isWriteTarget(parent);
};

/**
 * The initializer of the module-scope `const <name> = …` that `symbol`
 * resolves to, or `undefined` when it resolves to anything else.
 *
 * Resolved through the identifier's SYMBOL, not its spelling. A name-keyed
 * lookup answers for whichever declaration happens to share the text: a
 * function-local `const byUser = { key: (ctx) => ctx.args.email }` shadowing a
 * module-scope `const byUser = { key: (ctx) => ctx.auth.userId }` made the
 * feeder read the outer, safe object and miss the inner, spoofable one.
 *
 * `const` only, and module scope only. A `let` can be reassigned after its
 * initializer (`let o = { key: spoofable }; o = { key: safe }` — the feeder
 * would report the shape that never runs), and a binding declared inside a
 * function is out of reach of this one-hop read. Under-reporting is fail-safe;
 * reporting a stale or unrelated shape is not.
 */
const symbolConstInitializer = (symbol: TsSymbol | undefined): Node | undefined => {
    const declaration = symbol?.getDeclarations().find((candidate) => Node.isVariableDeclaration(candidate));

    if (!isConstDeclaration(declaration)) {
        return undefined;
    }

    const statement = declaration.getParent().getParent();

    return Node.isVariableStatement(statement) && Node.isSourceFile(statement.getParent()) ? declaration.getInitializer() : undefined;
};

/** The {@link symbolConstInitializer} of the binding `identifier` names. */
const moduleConstInitializer = (identifier: Identifier): Node | undefined => symbolConstInitializer(identifier.getSymbol());

/**
 * The object literal an options argument denotes: `node` itself when it already
 * IS one, or — when `node` is a bare identifier — the initializer of the
 * module-scope `const <name> = { … }` it binds to (see
 * {@link moduleConstInitializer}).
 *
 * Hoisting the options out of the call is how every example in this repo writes
 * a rate-limit guard (`const byUser = { key: … }; … rateLimit(limiter, "send",
 * byUser)`), so a feeder that inspects only a direct object-literal argument is
 * blind to the exact spelling its own examples use.
 */
const optionsObjectLiteral = (node: Node | undefined): ObjectLiteralExpression | undefined => {
    if (!node) {
        return undefined;
    }

    if (Node.isObjectLiteralExpression(node)) {
        return node;
    }

    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const initializer = moduleConstInitializer(node);

    return initializer !== undefined && Node.isObjectLiteralExpression(initializer) ? initializer : undefined;
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

/** Where {@link walkChain} stopped: at the chain's root, or at a call `settle` decided. */
type ChainEnd = { root: Node | undefined; verdict?: never } | { root?: never; verdict: boolean };

/**
 * Walk `value`'s member / call chain to its leftmost operand: through property
 * and element access, the callee side of calls, `await`, parentheses and
 * casts (`(await ctx.db.get(id)).owner` → `ctx`). `settle` is asked at each
 * call on the way and may end the walk with a verdict.
 */
const walkChain = (value: Node | undefined, settle?: (call: CallExpression) => boolean | undefined): ChainEnd => {
    let current: Node | undefined = unwrapExpression(value);

    while (
        Node.isAwaitExpression(current) ||
        Node.isPropertyAccessExpression(current) ||
        Node.isElementAccessExpression(current) ||
        Node.isCallExpression(current)
    ) {
        const verdict = Node.isCallExpression(current) ? settle?.(current) : undefined;

        if (verdict !== undefined) {
            return { verdict };
        }

        current = unwrapExpression(current.getExpression());
    }

    return { root: current };
};

/** The leftmost operand of `value`'s member / call chain (see {@link walkChain}). */
const chainRootOf = (value: Node | undefined): Node | undefined => walkChain(value).root;

/** Whether `node` is `other`: the same compiler node. */
const isSameNode = (node: Node | undefined, other: Node): boolean => node?.compilerNode === other.compilerNode;

/** The member a `<x>.k` / `<x>["k"]` access reads, and the expression it reads it off; `undefined` for anything else. */
const memberAccessOf = (node: Node | undefined): { member: string; object: Node } | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return { member: node.getName(), object: node.getExpression() };
    }

    const key = Node.isElementAccessExpression(node) ? node.getArgumentExpression() : undefined;

    return Node.isElementAccessExpression(node) && Node.isStringLiteral(key) ? { member: key.getLiteralValue(), object: node.getExpression() } : undefined;
};

/**
 * The function whose return value `node` is — `return node`, or an arrow's
 * expression body — or `undefined` when it is not returned.
 */
const returningFunctionOf = (node: Node): Node | undefined => {
    const parent = node.getParent();
    const isReturned = Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === node);

    return isReturned ? node.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor)) : undefined;
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

    const property = findObjectProperty(object, name);

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralText() : undefined;
};

/** The sole statement of a single-statement `{ return {...}; }` block, when it returns an object literal. */
const objectLiteralFromReturnBlock = (block: Block): ObjectLiteralExpression | undefined => {
    const statements = block.getStatements();
    const [statement] = statements;

    if (statements.length !== 1 || statement === undefined || !Node.isReturnStatement(statement)) {
        return undefined;
    }

    const expression = statement.getExpression();

    return expression !== undefined && Node.isObjectLiteralExpression(expression) ? expression : undefined;
};

/**
 * The object literal a callback body evaluates to, covering the concise-body
 * form (`() => ({...})`, where the parens make the object literal the whole
 * body) and the block-body form (`() => { return {...}; }`). Anything else
 * (a variable, a multi-statement block, a conditional) is not analyzable.
 *
 * Shared by the two readers of the generated `.extend(fn)` escape hatch —
 * `discover/config-calls` (which keys) and `discover/worker-entry-crons` (which
 * cron expressions) — because they must agree on which `.extend()` bodies are
 * statically readable at all.
 */
const objectLiteralFromCallbackBody = (body: Node): ObjectLiteralExpression | undefined => {
    if (Node.isObjectLiteralExpression(body)) {
        return body;
    }

    if (Node.isParenthesizedExpression(body)) {
        const inner = body.getExpression();

        return Node.isObjectLiteralExpression(inner) ? inner : undefined;
    }

    return Node.isBlock(body) ? objectLiteralFromReturnBlock(body) : undefined;
};

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

/** The `FunctionReference` roots codegen emits (`api.<namespace>.<export>` / `internal.…`). */
const FUNCTION_REFERENCE_ROOTS: ReadonlySet<string> = new Set(["api", "internal"]);

/** Context methods that call a Lunora function by reference (`ctx.runQuery(api.x.y, …)`, a queue's `message.run(…)`). */
const RUN_METHODS: ReadonlySet<string> = new Set(["run", "runAction", "runMutation", "runQuery"]);

/**
 * The member path of a static `api.<…>.<export>` / `internal.<…>.<export>` chain,
 * root excluded (`["messages", "send"]`), or `undefined` for anything else — a
 * variable, a computed member, a call result.
 */
const functionReferenceSegments = (node: Node | undefined): string[] | undefined => {
    if (node === undefined || !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const segments: string[] = [];
    let current: Node = node;

    while (Node.isPropertyAccessExpression(current)) {
        segments.unshift(current.getName());
        current = current.getExpression();
    }

    return Node.isIdentifier(current) && FUNCTION_REFERENCE_ROOTS.has(current.getText()) && segments.length >= 2 ? segments : undefined;
};

/**
 * A static function reference as the `namespace:export` key the function
 * registry uses: the path joined with `_` (`api.billing.invoices.create` →
 * `billing_invoices:create`). Must agree with the `anyApi` proxy
 * (`shared/any-api.ts`), which builds the same key at runtime.
 */
const functionKeyOf = (node: Node | undefined): string | undefined => {
    const segments = functionReferenceSegments(node);

    return segments === undefined ? undefined : `${segments.slice(0, -1).join("_")}:${String(segments.at(-1))}`;
};

export {
    bindingKeyName,
    chainRootOf,
    collectCallRows,
    collectNodeRows,
    collectSecurityCallRows,
    defaultExportExpression,
    findObjectProperty,
    functionKeyOf,
    functionReferenceSegments,
    handlerOf,
    isConstDeclaration,
    isSameNode,
    isTestPath,
    isWriteTarget,
    limitNameOf,
    listLunoraSourceFiles,
    listSecurityScanFiles,
    lunoraRelativePath,
    memberAccessOf,
    objectLiteralFromCallbackBody,
    optionsObjectLiteral,
    outermostValueWrapper,
    propertyInitializer,
    returningFunctionOf,
    RUN_METHODS,
    stringPropertyFor,
    stringPropertyOf,
    symbolConstInitializer,
    TS_EXTENSION_RE,
    unwrapExpression,
    unwrapToCallExpression,
    walkChain,
};
export type { ChainEnd, RowsOf, ScannedSourceFile };

export { propertyKeyName, propertyNameText } from "./property-name";
