/**
 * The privacy coverage lint (plan 468, WS H). A table that holds a user's data, meaning it has a
 * `userId` column, must be exported and erased by a dataset, or excluded with a reason. Codegen reads
 * the `defineDataset`, built-in dataset and `definePrivacy({ exclude })` literals and fails the build on
 * any table left over. It also fails on a `defineDataset` that no `definePrivacy` passes, when the
 * `datasets` literal is statically resolvable.
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
import type { TableIR } from "../ir";
import { listLunoraSourceFiles } from "./ast";

/** The package whose declaration turns the lint on. Read from the same manifest signal `studio-features` uses. */
const PRIVACY_PACKAGE = "@lunora/privacy";

/** The column that marks a table as holding a user's data. */
const OWNER_COLUMN = "userId";

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

/** `authDataset(renames?)`: the default better-auth names, minus the renamed ones, plus the renamed values. */
const coverAuth = (call: CallExpression, state: CoverageState): void => {
    const argument = call.getArguments()[0];
    const renames = argument !== undefined && Node.isObjectLiteralExpression(argument) ? assignmentsOf(argument) : [];
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
        }
    }
};

/** `documentHistoryDataset(table?)` and `actionCacheDataset(table?)`: the named table, or the default. */
const coverNamedTable = (call: CallExpression, state: CoverageState, fallback: string): void => {
    state.datasets.set(stringValue(call.getArguments()[0]) ?? fallback, fallback);
};

/** `definePrivacy(config)`: reads its `exclude` literal. */
const readPrivacyConfig = (call: CallExpression, state: CoverageState): void => {
    const config = call.getArguments()[0];
    const exclude = config !== undefined && Node.isObjectLiteralExpression(config) ? literalProperty(config, "exclude") : undefined;

    for (const property of exclude === undefined ? [] : assignmentsOf(exclude)) {
        state.excluded.set(keyOf(property), Node.isPropertyAssignment(property) ? (stringValue(property.getInitializer()) ?? "") : "");
    }
};

/** Route one call expression to the handler for its callee. */
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
        case "definePrivacy": {
            readPrivacyConfig(call, state);
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
 * The `defineDataset` declarations one `definePrivacy` call passes. Returns `undefined` when any element
 * cannot be resolved statically (a spread, a non-literal `datasets`, an identifier that is not a dataset), or
 * when `datasets` is absent beside a spread of the config, which may carry it. An opaque element could be the dataset that looks unused, so the caller must then report nothing.
 */
const passedDatasetsOf = (call: CallExpression): Set<VariableDeclaration> | undefined => {
    const config = call.getArguments()[0];

    if (config === undefined || !Node.isObjectLiteralExpression(config)) {
        return undefined;
    }

    const property = config.getProperty("datasets");

    if (property === undefined) {
        // A spread (`definePrivacy({ ...config })`) may carry the datasets, so nothing can be called unused.
        return config.getProperties().some((candidate) => Node.isSpreadAssignment(candidate)) ? undefined : new Set();
    }

    const value = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;

    if (value === undefined || !Node.isArrayLiteralExpression(value)) {
        return undefined;
    }

    const passed = new Set<VariableDeclaration>();

    for (const element of value.getElements()) {
        if (isDefineDatasetCall(element) || isBuiltinDatasetCall(element)) {
            // An inline dataset is passed by construction, so nothing can be unused here.
            continue;
        }

        const declaration = Node.isIdentifier(element) ? datasetDeclarationOf(element) : undefined;

        if (declaration === undefined) {
            return undefined;
        }

        passed.add(declaration);
    }

    return passed;
};

/** What one file contributes: its named `defineDataset` variables, and the `datasets` literal of each `definePrivacy`. */
interface FileFacts {
    readonly declared: ReadonlyArray<DatasetDeclaration>;
    /** One entry per `definePrivacy` call: the datasets it passes, or `undefined` when they cannot be resolved. */
    readonly privacyCalls: ReadonlyArray<Set<VariableDeclaration> | undefined>;
}

/** Read one file: every call feeds the classifier, and every named `defineDataset` variable is returned. */
const scanFile = (file: SourceFile, state: CoverageState): FileFacts => {
    const privacyCalls: (Set<VariableDeclaration> | undefined)[] = [];

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        visitCall(call, state);

        if (calleeName(call) === "definePrivacy") {
            privacyCalls.push(passedDatasetsOf(call));
        }
    }

    const declared = file
        .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
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
        return { classifications: {}, enabled: false, unusedDatasets: [] };
    }

    const state: CoverageState = { datasets: new Map<string, string>(), excluded: new Map<string, string>() };
    const declared: DatasetDeclaration[] = [];
    const privacyCalls: (Set<VariableDeclaration> | undefined)[] = [];

    for (const file of coverageFiles(project, lunoraDirectory)) {
        const facts = scanFile(file, state);

        declared.push(...facts.declared);
        privacyCalls.push(...facts.privacyCalls);
    }

    const passed = new Set<VariableDeclaration>();

    for (const call of privacyCalls) {
        for (const declaration of call ?? []) {
            passed.add(declaration);
        }
    }

    // A `defineDataset` that is not bound to a variable (passed inline, or stored elsewhere) is never reported:
    // only a named constant can be matched to a `datasets` entry. Nothing is reported while any `datasets`
    // literal is unresolvable, because its opaque element could be the dataset that looks unused.
    const resolvable = privacyCalls.every((call) => call !== undefined);
    const unusedDatasets = resolvable ? declared.filter((entry) => !passed.has(entry.declaration)).map((entry) => entry.name) : [];

    // An exclusion overwrites a dataset, as it does in `definePrivacy().coverage`.
    const classifications = classifyTables(state.datasets, state.excluded);

    return { classifications, enabled: privacyCalls.length > 0, unusedDatasets };
};

/** A table holds a user's data when it has an owner column and is not one of the privacy package's own tables. */
const holdsUserData = (table: TableIR): boolean => table.extensionKey !== PRIVACY_EXTENSION_KEY && OWNER_COLUMN in table.shape;

/** The message for one coverage problem. Names the table, so the reviewer knows which one to fix. */
const messageFor = (problem: CoverageProblem): string =>
    problem.code === "excluded_without_reason"
        ? `privacy_exclusion_unexplained: "${problem.table}" is excluded without a reason. Give one in definePrivacy({ exclude }).`
        : `privacy_table_unclassified: "${problem.table}" holds user data (it has a "${OWNER_COLUMN}" column) but no dataset exports it. Add it to a defineDataset, or exclude it in definePrivacy({ exclude }) with a reason.`;

/**
 * Fail when the app uses the package and a table with user data is neither covered by a dataset nor excluded
 * with a reason, or when a declared dataset is never passed to `definePrivacy`. The message names the table or
 * dataset.
 */
const assertPrivacyCoverage = (tables: ReadonlyArray<TableIR>, coverage: PrivacyCoverage): void => {
    if (!coverage.enabled) {
        return;
    }

    const owned = tables.filter((candidate) => holdsUserData(candidate)).map((table) => table.name);
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
