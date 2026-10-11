/**
 * The privacy coverage lint (plan 468, WS H). A table that holds a user's data,
 * meaning it has a `userId` column, must be exported and erased by a dataset, or
 * excluded with a reason. Codegen reads the `defineDataset`, built-in dataset and
 * `definePrivacy({ exclude })` literals and fails the build on any table left over.
 *
 * It reads literals only, and it is opt-in: an app that does not call
 * `definePrivacy` is not checked, so the lint never fails an app that does not use
 * the package.
 */
import { LunoraError } from "@lunora/errors";
import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { TableIR } from "../ir";

/** The column that marks a table as holding a user's data. */
const OWNER_COLUMN = "userId";

/** The better-auth tables `authDataset()` covers by default. Mirrors `@lunora/privacy`. */
const AUTH_DEFAULT_TABLES: ReadonlyArray<string> = ["account", "apikey", "member", "passkey", "session", "teamMember", "twoFactor", "user"];

/** Tables the privacy package owns; they are never a user's data to export. */
const PACKAGE_TABLE_PREFIX = "privacy_";

interface PrivacyCoverage {
    /** Table names a dataset exports and erases. */
    readonly covered: ReadonlySet<string>;
    /** `true` once the app calls `definePrivacy`. The lint is opt-in. */
    readonly enabled: boolean;
    /** Table names excluded with their reason. */
    readonly excluded: ReadonlyMap<string, string>;
}

/** Mutable accumulator the handlers write into. */
interface CoverageState {
    readonly covered: Set<string>;
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

/** `defineDataset(id, config)`: every table the config lists is covered. */
const coverDataset = (call: CallExpression, state: CoverageState): void => {
    const config = call.getArguments()[1];

    if (config === undefined || !Node.isObjectLiteralExpression(config)) {
        return;
    }

    const tables = literalProperty(config, "tables");

    for (const table of tables === undefined ? [] : assignmentsOf(tables).map((property) => keyOf(property))) {
        state.covered.add(table);
    }
};

/** `authDataset(renames?)`: the default better-auth names, minus the renamed ones, plus the renamed values. */
const coverAuth = (call: CallExpression, state: CoverageState): void => {
    const argument = call.getArguments()[0];
    const renames = argument !== undefined && Node.isObjectLiteralExpression(argument) ? assignmentsOf(argument) : [];
    const overridden = new Set(renames.map((rename) => keyOf(rename)));

    for (const table of AUTH_DEFAULT_TABLES) {
        if (!overridden.has(table)) {
            state.covered.add(table);
        }
    }

    for (const rename of renames) {
        const value = Node.isPropertyAssignment(rename) ? stringValue(rename.getInitializer()) : undefined;

        if (value !== undefined) {
            state.covered.add(value);
        }
    }
};

/** `documentHistoryDataset(table?)` and `actionCacheDataset(table?)`: the named table, or the default. */
const coverNamedTable = (call: CallExpression, state: CoverageState, fallback: string): void => {
    state.covered.add(stringValue(call.getArguments()[0]) ?? fallback);
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
    const callee = call.getExpression();

    if (!Node.isIdentifier(callee)) {
        return;
    }

    switch (callee.getText()) {
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

/** `true` for a call to `definePrivacy`, which marks the app as using the package. */
const isDefinePrivacy = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    return Node.isIdentifier(callee) && callee.getText() === "definePrivacy";
};

/** Read the coverage the app declares across its `lunora/` files. */
const discoverPrivacyCoverage = (project: Project, lunoraDirectory: string): PrivacyCoverage => {
    // Discovery runs before the other lunora files are loaded, so load them here. Generated output is
    // skipped: it never declares a dataset, and a stale copy must not count as coverage.
    project.addSourceFilesAtPaths([`${lunoraDirectory}/**/*.ts`, `!${lunoraDirectory}/_generated/**`]);

    const state: CoverageState = { covered: new Set<string>(), excluded: new Map<string, string>() };
    let enabled = false;

    for (const file of project.getSourceFiles()) {
        if (file.getFilePath().startsWith(`${lunoraDirectory}/`)) {
            for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                enabled = enabled || isDefinePrivacy(call);
                visitCall(call, state);
            }
        }
    }

    return { covered: state.covered, enabled, excluded: state.excluded };
};

/** A table holds a user's data when it has an owner column and is not one of the package's own tables. */
const holdsUserData = (table: TableIR): boolean =>
    table.extensionKey !== "privacy" && !table.name.startsWith(PACKAGE_TABLE_PREFIX) && OWNER_COLUMN in table.shape;

/**
 * Fail when the app uses the package and a table with user data is neither
 * covered by a dataset nor excluded with a reason. The message names the table.
 */
const assertPrivacyCoverage = (tables: ReadonlyArray<TableIR>, coverage: PrivacyCoverage): void => {
    if (!coverage.enabled) {
        return;
    }

    for (const table of tables.filter((candidate) => holdsUserData(candidate))) {
        if (coverage.covered.has(table.name)) {
            continue;
        }

        if (!coverage.excluded.has(table.name)) {
            throw new LunoraError(
                "PRIVACY_COVERAGE",
                `privacy_table_unclassified: "${table.name}" holds user data (it has a "${OWNER_COLUMN}" column) but no dataset exports it. Add it to a defineDataset, or exclude it in definePrivacy({ exclude }) with a reason.`,
            );
        }

        if ((coverage.excluded.get(table.name) ?? "").trim() === "") {
            throw new LunoraError(
                "PRIVACY_COVERAGE",
                `privacy_table_unclassified: "${table.name}" is excluded without a reason. Give one in definePrivacy({ exclude }).`,
            );
        }
    }
};

export { assertPrivacyCoverage, discoverPrivacyCoverage, type PrivacyCoverage };
