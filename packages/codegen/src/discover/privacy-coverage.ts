/**
 * The privacy coverage lint (plan 468, WS H). A table that holds a user's data, meaning it has a
 * `userId` column, must be exported and erased by a dataset, or excluded with a reason. Codegen reads
 * the `defineDataset`, built-in dataset and `definePrivacy({ exclude })` literals and fails the build on
 * any table left over. It also fails on a `defineDataset` that no `definePrivacy` passes. A config spread
 * into `definePrivacy` is followed to its object literal; when the `datasets` cannot be resolved, it warns.
 *
 * It reads literals only. It runs only when the app declares `@lunora/privacy`, so an app without the
 * package never has its files parsed for this lint.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { CallExpression, ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CoverageProblem, TableClassification } from "../../../../shared/privacy-coverage";
import { AUTH_DEFAULT_TABLES, checkCoverage, classifyTables } from "../../../../shared/privacy-coverage";
import type { TableIR, ValidatorIR } from "../ir";
import { descendantsOfKind, listLunoraSourceFiles } from "./ast";

/** The package whose declaration turns the lint on. Read from the same manifest signal `studio-features` uses. */
const PRIVACY_PACKAGE = "@lunora/privacy";

/** The column that marks a table as holding a user's data, by name. A `v.id` of a user table marks it too. */
const OWNER_COLUMN = "userId";

/** The tables a `v.id` must name to mark its row as holding a user's data: the app's own and the better-auth one. */
const USER_TABLES: ReadonlySet<string> = new Set(["user", "users"]);

/** Same normalisation as `toPosixPath` in `run-codegen.ts`: `getFilePath()` is POSIX, OS paths may not be. */
const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

/** The package's own extension key. Its tables are the only exemption: an app table named `privacy_*` is checked. */
const PRIVACY_EXTENSION_KEY = "privacy";

/** Built-in dataset factories. The app never declares them with `defineDataset`, so they are known, not unused. */
const BUILTIN_DATASET_CALLS: ReadonlySet<string> = new Set(["actionCacheDataset", "authDataset", "documentHistoryDataset"]);

/**
 * What the lint learned from the app's `lunora/` files. `classifications` is built the way
 * `definePrivacy().coverage` builds it at runtime: datasets first, then exclusions overwrite them.
 */
interface PrivacyCoverage {
    /** Table name to the dataset or exclusion that accounts for it. */
    readonly classifications: Readonly<Record<string, TableClassification>>;
    /** `true` once the app declares the package and calls `definePrivacy`. The lint is opt-in. */
    readonly enabled: boolean;
    /** Names of `defineDataset` constants that no `definePrivacy` passes. Empty when the `datasets` literal cannot be resolved. */
    readonly unusedDatasets: ReadonlyArray<string>;
    /** The table names a `v.id` may name to mark its row as holding user data: the defaults and any renamed auth user table. */
    readonly userTables: ReadonlySet<string>;
}

/** A named `defineDataset` variable found in a lunora file. */
interface DatasetDeclaration {
    readonly declaration: VariableDeclaration;
    readonly name: string;
}

/** Mutable accumulator the handlers write into. */
interface CoverageState {
    /** Table name to the dataset (or built-in) that exports it. */
    readonly datasets: Map<string, string>;
    /** Table name to the exclusion reason. */
    readonly excluded: Map<string, string>;
    /** Starts as the default user tables; `authDataset` adds the name it renamed the user table to. */
    readonly userTables: Set<string>;
}

/** The text of a string literal, or `undefined` for anything else. */
const stringValue = (node: Node | undefined): string | undefined =>
    node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralText() : undefined;

/** The key of a property assignment, without its quotes. */
const keyOf = (property: Node): string => (Node.isPropertyAssignment(property) ? property.getName().replaceAll(/^["']|["']$/gu, "") : "");

/** The property assignments of an object literal. */
const assignmentsOf = (object: ObjectLiteralExpression): Node[] => object.getProperties().filter((property) => Node.isPropertyAssignment(property));

/** The object literal under `name` in `object`, or `undefined` when it is not a literal. */
const literalProperty = (object: ObjectLiteralExpression, name: string): ObjectLiteralExpression | undefined => {
    const property = object.getProperty(name);
    const value = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;

    return value !== undefined && Node.isObjectLiteralExpression(value) ? value : undefined;
};

/** The bare identifier a call is made through, or `undefined` for member or computed calls. */
const calleeName = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    return Node.isIdentifier(callee) ? callee.getText() : undefined;
};

/** `defineDataset(id, config)`: every table the config lists is covered by the dataset id. */
const coverDataset = (call: CallExpression, state: CoverageState): void => {
    const config = call.getArguments()[1];

    if (config === undefined || !Node.isObjectLiteralExpression(config)) {
        return;
    }

    const tables = literalProperty(config, "tables");
    const dataset = stringValue(call.getArguments()[0]) ?? "defineDataset";

    for (const table of tables === undefined ? [] : assignmentsOf(tables).map((property) => keyOf(property))) {
        state.datasets.set(table, dataset);
    }
};

/** How many identifiers or spreads the config reader follows before it gives up, so a cycle cannot loop. */
const MAX_RESOLVE_DEPTH = 8;

/**
 * The expression a node stands for: `as`, `satisfies` and parentheses are unwrapped, and an identifier is
 * followed (through an import alias too) to its variable's initializer. Returns the node itself when it is
 * neither, and `undefined` when an identifier has no variable initializer to follow.
 */
const resolveExpression = (node: Node, depth = 0): Node | undefined => {
    if (depth > MAX_RESOLVE_DEPTH) {
        return undefined;
    }

    if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isParenthesizedExpression(node)) {
        return resolveExpression(node.getExpression(), depth + 1);
    }

    if (!Node.isIdentifier(node)) {
        return node;
    }

    const symbol = node.getSymbol();
    const declaration = (symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol)?.getValueDeclaration();
    const initializer = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;

    return initializer === undefined ? undefined : resolveExpression(initializer, depth + 1);
};

/** `authDataset(renames?)`: the default better-auth names, minus the renamed ones, plus the renamed values. */
const coverAuth = (call: CallExpression, state: CoverageState): void => {
    const argument = call.getArguments()[0];
    const object = argument === undefined ? undefined : resolveExpression(argument);
    const renames = object !== undefined && Node.isObjectLiteralExpression(object) ? assignmentsOf(object) : [];
    const overridden = new Set(renames.map((rename) => keyOf(rename)));

    for (const table of AUTH_DEFAULT_TABLES) {
        if (!overridden.has(table)) {
            state.datasets.set(table, "authDataset");
        }
    }

    for (const rename of renames) {
        const value = Node.isPropertyAssignment(rename) ? stringValue(rename.getInitializer()) : undefined;

        if (value !== undefined) {
            state.datasets.set(value, "authDataset");

            if (keyOf(rename) === "user") {
                state.userTables.add(value);
            }
        }
    }
};

/** `documentHistoryDataset(table?)` and `actionCacheDataset(table?)`: the named table, or the default. */
const coverNamedTable = (call: CallExpression, state: CoverageState, fallback: string): void => {
    state.datasets.set(stringValue(call.getArguments()[0]) ?? fallback, fallback);
};

/** The name and value expression of one plain or shorthand property, or `undefined` for any other member. */
const propertyEntry = (property: Node): [string, Node] | undefined => {
    if (Node.isPropertyAssignment(property)) {
        const value = property.getInitializer();

        return value === undefined ? undefined : [keyOf(property), value];
    }

    if (Node.isShorthandPropertyAssignment(property)) {
        // `{ datasets }`: the name node's symbol is the property's, so follow the value symbol to the variable,
        // through an import alias when the variable is imported (as `resolveExpression` does for an identifier).
        const symbol = property.getValueSymbol();
        const declaration = (symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol)?.getValueDeclaration();
        const value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;

        // Kept even when it cannot be followed, so a `datasets` read from it is unresolvable rather than absent.
        return [property.getName(), value ?? property.getNameNode()];
    }

    return undefined;
};

/**
 * The properties a `definePrivacy` config object ends up with, by name, as the expression each one is set to.
 * A spread of an identifier is followed to its object literal, in the same file or an imported one, and a later
 * property overrides an earlier one, as at runtime. Returns `undefined` when a spread cannot be followed to an
 * object literal: it could carry `datasets` or `exclude`.
 */
const configProperties = (config: Node, depth = 0): Map<string, Node> | undefined => {
    const object = resolveExpression(config, depth);

    if (object === undefined || !Node.isObjectLiteralExpression(object) || depth > MAX_RESOLVE_DEPTH) {
        return undefined;
    }

    const properties = new Map<string, Node>();

    for (const property of object.getProperties()) {
        const entries = Node.isSpreadAssignment(property) ? configProperties(property.getExpression(), depth + 1) : [propertyEntry(property)];

        if (entries === undefined) {
            return undefined;
        }

        for (const entry of entries) {
            if (entry !== undefined) {
                properties.set(entry[0], entry[1]);
            }
        }
    }

    return properties;
};

/** The resolved properties of a `definePrivacy(config)` call, or `undefined` when the config cannot be read statically. */
const privacyConfigOf = (call: CallExpression): Map<string, Node> | undefined => {
    const config = call.getArguments()[0];

    return config === undefined ? undefined : configProperties(config);
};

/** `definePrivacy(config)`: reads its `exclude` literal, through a spread or an identifier when it can be followed. */
const readPrivacyConfig = (config: ReadonlyMap<string, Node> | undefined, state: CoverageState): void => {
    const value = config?.get("exclude");
    const exclude = value === undefined ? undefined : resolveExpression(value);

    for (const property of exclude !== undefined && Node.isObjectLiteralExpression(exclude) ? assignmentsOf(exclude) : []) {
        state.excluded.set(keyOf(property), Node.isPropertyAssignment(property) ? (stringValue(property.getInitializer()) ?? "") : "");
    }
};

/** Route one call expression to the handler for its callee. `definePrivacy` is read by {@link scanFile}. */
const visitCall = (call: CallExpression, state: CoverageState): void => {
    switch (calleeName(call)) {
        case "actionCacheDataset": {
            coverNamedTable(call, state, "actionCache");
            break;
        }
        case "authDataset": {
            coverAuth(call, state);
            break;
        }
        case "defineDataset": {
            coverDataset(call, state);
            break;
        }
        case "documentHistoryDataset": {
            coverNamedTable(call, state, "documentHistory");
            break;
        }
        default: {
            break;
        }
    }
};

/** `true` when the node is a `defineDataset(...)` call. */
const isDefineDatasetCall = (node: Node | undefined): node is CallExpression =>
    node !== undefined && Node.isCallExpression(node) && calleeName(node) === "defineDataset";

/** `true` when the node is a call to a built-in dataset factory. */
const isBuiltinDatasetCall = (node: Node | undefined): node is CallExpression =>
    node !== undefined && Node.isCallExpression(node) && BUILTIN_DATASET_CALLS.has(calleeName(node) ?? "");

/**
 * The variable an identifier refers to, following an import alias to its source, when that variable is a
 * `defineDataset` or built-in dataset. Returns `undefined` otherwise, which makes the caller treat the whole
 * `datasets` literal as unresolvable.
 */
const datasetDeclarationOf = (identifier: Node): VariableDeclaration | undefined => {
    const symbol = identifier.getSymbol();
    const target = symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol;
    const declaration = target?.getValueDeclaration();
    const initializer = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;

    return Node.isVariableDeclaration(declaration) && (isDefineDatasetCall(initializer) || isBuiltinDatasetCall(initializer)) ? declaration : undefined;
};

/**
 * Add the dataset declarations an array expression lists to `passed`. A spread element is followed to its
 * array literal. Returns `false` when any element cannot be resolved statically: an opaque element could be the
 * dataset that looks unused.
 */
const collectPassed = (list: Node, passed: Set<VariableDeclaration>, depth = 0): boolean => {
    const array = resolveExpression(list, depth);

    if (array === undefined || !Node.isArrayLiteralExpression(array) || depth > MAX_RESOLVE_DEPTH) {
        return false;
    }

    for (const element of array.getElements()) {
        if (Node.isSpreadElement(element)) {
            if (!collectPassed(element.getExpression(), passed, depth + 1)) {
                return false;
            }
        } else if (!isDefineDatasetCall(element) && !isBuiltinDatasetCall(element)) {
            // An inline dataset is passed by construction, so only a named one needs matching.
            const declaration = Node.isIdentifier(element) ? datasetDeclarationOf(element) : undefined;

            if (declaration === undefined) {
                return false;
            }

            passed.add(declaration);
        }
    }

    return true;
};

/**
 * The `defineDataset` declarations one `definePrivacy` call passes, read from its resolved config. Returns
 * `undefined` when the config or its `datasets` cannot be resolved statically.
 */
const passedDatasetsOf = (config: ReadonlyMap<string, Node> | undefined): Set<VariableDeclaration> | undefined => {
    if (config === undefined) {
        return undefined;
    }

    const value = config.get("datasets");
    const passed = new Set<VariableDeclaration>();

    return value === undefined || collectPassed(value, passed) ? passed : undefined;
};

/** One `definePrivacy` call: where it is, and the datasets it passes (`undefined` when they cannot be resolved). */
interface PrivacyCall {
    readonly location: string;
    readonly passed: Set<VariableDeclaration> | undefined;
}

/** What one file contributes: its named `defineDataset` variables, and each `definePrivacy` call's datasets. */
interface FileFacts {
    readonly declared: ReadonlyArray<DatasetDeclaration>;
    readonly privacyCalls: ReadonlyArray<PrivacyCall>;
}

/** Read one file: every call feeds the classifier, and every named `defineDataset` variable is returned. */
const scanFile = (file: SourceFile, state: CoverageState): FileFacts => {
    const privacyCalls: PrivacyCall[] = [];

    for (const call of descendantsOfKind(file, SyntaxKind.CallExpression)) {
        visitCall(call, state);

        if (calleeName(call) === "definePrivacy") {
            const config = privacyConfigOf(call);

            readPrivacyConfig(config, state);
            privacyCalls.push({ location: `${file.getFilePath()}:${String(call.getStartLineNumber())}`, passed: passedDatasetsOf(config) });
        }
    }

    const declared = descendantsOfKind(file, SyntaxKind.VariableDeclaration)
        .filter((declaration) => isDefineDatasetCall(declaration.getInitializer()))
        .map((declaration) => {
            return { declaration, name: declaration.getName() };
        });

    return { declared, privacyCalls };
};

/**
 * The lunora files the lint reads: codegen's own source listing, which applies `codegen.exclude` and skips
 * tests, mocks, fixtures and `node_modules`, plus `schema.ts`, which the listing drops. Each file is loaded
 * into the project if it is not there already, then the project's own files are returned. The only path
 * comparison is between two POSIX-normalised strings, so it holds on Windows too.
 */
const coverageFiles = (project: Project, lunoraDirectory: string): SourceFile[] => {
    const schemaPath = join(lunoraDirectory, "schema.ts");
    const listed = [...listLunoraSourceFiles(lunoraDirectory), ...(existsSync(schemaPath) ? [schemaPath] : [])];

    for (const path of listed) {
        if (project.getSourceFile(path) === undefined) {
            project.addSourceFileAtPath(path);
        }
    }

    // `getFilePath()` is always POSIX while the listing carries the OS separator, so normalise both sides.
    const wanted = new Set(listed.map((path) => toPosixPath(path)));

    return project.getSourceFiles().filter((file) => wanted.has(file.getFilePath()));
};

/**
 * Read the coverage the app declares across its `lunora/` files. The lint runs only when `declaredDependencies`
 * holds `@lunora/privacy`; without it no extra file is loaded.
 */
const discoverPrivacyCoverage = (project: Project, lunoraDirectory: string, declaredDependencies: ReadonlySet<string> | undefined): PrivacyCoverage => {
    if (declaredDependencies?.has(PRIVACY_PACKAGE) !== true) {
        return { classifications: {}, enabled: false, unusedDatasets: [], userTables: USER_TABLES };
    }

    const state: CoverageState = { datasets: new Map<string, string>(), excluded: new Map<string, string>(), userTables: new Set(USER_TABLES) };
    const declared: DatasetDeclaration[] = [];
    const privacyCalls: PrivacyCall[] = [];

    for (const file of coverageFiles(project, lunoraDirectory)) {
        const facts = scanFile(file, state);

        declared.push(...facts.declared);
        privacyCalls.push(...facts.privacyCalls);
    }

    const passed = new Set<VariableDeclaration>();

    for (const call of privacyCalls) {
        for (const declaration of call.passed ?? []) {
            passed.add(declaration);
        }

        if (call.passed === undefined) {
            // eslint-disable-next-line no-console -- matches the other skip warnings in this package; there is no diagnostic sink here.
            console.warn(
                `@lunora/codegen: privacy_datasets_unresolved: the definePrivacy call at ${call.location} passes datasets codegen cannot read, so a defineDataset it leaves out is not reported. Pass an array of dataset constants, directly or through a spread of a config object literal.`,
            );
        }
    }

    // A `defineDataset` that is not bound to a variable (passed inline, or stored elsewhere) is never reported:
    // only a named constant can be matched to a `datasets` entry. Nothing is reported while any `datasets`
    // value is unresolvable, because its opaque element could be the dataset that looks unused; the warning
    // above says so instead of staying silent.
    const resolvable = privacyCalls.every((call) => call.passed !== undefined);
    const unusedDatasets = resolvable ? declared.filter((entry) => !passed.has(entry.declaration)).map((entry) => entry.name) : [];

    // An exclusion overwrites a dataset, as it does in `definePrivacy().coverage`.
    const classifications = classifyTables(state.datasets, state.excluded);

    return { classifications, enabled: privacyCalls.length > 0, unusedDatasets, userTables: state.userTables };
};

/**
 * A `v.id` of a user table, looking through the wrappers that nest a validator: `v.optional`, `v.array`, `v.union`
 * (a nullable reference is a union of the id and `v.null()`), `v.record` and `v.object`.
 */
const referencesUser = (validator: ValidatorIR, userTables: ReadonlySet<string>): boolean => {
    if (validator.kind === "id") {
        return userTables.has(validator.tableName ?? "");
    }

    const nested = [validator.inner, validator.keyType, validator.valueType, ...(validator.members ?? []), ...Object.values(validator.shape ?? {})];

    return nested.some((child) => child !== undefined && referencesUser(child, userTables));
};

/**
 * A table holds a user's data when it has an owner column, or a `v.id` of a user table, and is not one of the
 * privacy package's own tables. The `v.id` case catches a table whose owner column is named otherwise.
 */
const holdsUserData = (table: TableIR, userTables: ReadonlySet<string>): boolean =>
    table.extensionKey !== PRIVACY_EXTENSION_KEY &&
    (OWNER_COLUMN in table.shape || Object.values(table.shape).some((validator) => referencesUser(validator, userTables)));

/** The message for one coverage problem. Names the table, so the reviewer knows which one to fix. */
const messageFor = (problem: CoverageProblem): string =>
    problem.code === "excluded_without_reason"
        ? `privacy_exclusion_unexplained: "${problem.table}" is excluded without a reason. Give one in definePrivacy({ exclude }).`
        : `privacy_table_unclassified: "${problem.table}" holds user data (a "${OWNER_COLUMN}" column or a v.id of a user table) but no dataset exports it. Add it to a defineDataset, or exclude it in definePrivacy({ exclude }) with a reason.`;

/**
 * Fail when the app uses the package and a table with user data is neither covered by a dataset nor excluded
 * with a reason, or when a declared dataset is never passed to `definePrivacy`. The message names the table or
 * dataset.
 */
const assertPrivacyCoverage = (tables: ReadonlyArray<TableIR>, coverage: PrivacyCoverage): void => {
    if (!coverage.enabled) {
        return;
    }

    const owned = tables.filter((candidate) => holdsUserData(candidate, coverage.userTables)).map((table) => table.name);
    const [problem] = checkCoverage(owned, coverage.classifications);

    if (problem !== undefined) {
        throw new LunoraError("PRIVACY_COVERAGE", messageFor(problem));
    }

    const [unused] = coverage.unusedDatasets;

    if (unused !== undefined) {
        throw new LunoraError(
            "PRIVACY_COVERAGE",
            `privacy_dataset_unused: "${unused}" is declared with defineDataset but never passed to definePrivacy({ datasets }). Pass it, or delete it.`,
        );
    }
};

export { assertPrivacyCoverage, discoverPrivacyCoverage, type PrivacyCoverage };
