import type {
    ArrowFunction,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    ObjectLiteralExpression,
    Project,
    SourceFile,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { MigrationIR } from "../ir";
import { isServerPackageModule } from "../module-specifiers";
import { findObjectProperty, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { addressableExportNameOf, exportedVariableDeclarationsOf } from "./attribution";

/**
 * Decide whether a callee identifier refers to `@lunora/server`'s
 * `defineMigration` (granular or through the `lunorash/server` umbrella subpath —
 * an unrecognized specifier silently drops the migration from
 * `LUNORA_MIGRATIONS`, so `lunora migrate up` finds nothing). Mirrors
 * `resolveCalleeKind`: trust the import declaration when the type checker has one
 * (so `import { defineMigration as dm }` still resolves), and fall back to the
 * surface text when no symbol is available (no tsconfig wired up).
 */
const isDefineMigration = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineMigration";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isServerPackageModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineMigration";
    }

    return false;
};

/** Read a static string-literal property off the `defineMigration({...})` argument, or undefined. */
const stringProperty = (object: ObjectLiteralExpression, name: string): string | undefined => {
    const property = findObjectProperty(object, name);

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/**
 * The `covers: { … }` a migration declares, when every value is a literal of the kind it takes. A `covers` that cannot be read this
 * way yields `undefined`, so the migration covers nothing: the gate cannot match a declaration it cannot see.
 */
const coversOf = (object: ObjectLiteralExpression): MigrationIR["covers"] => {
    const property = findObjectProperty(object, "covers");
    const value = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;

    if (value === undefined || !Node.isObjectLiteralExpression(value)) {
        return undefined;
    }

    const covers: NonNullable<MigrationIR["covers"]> = {};

    for (const key of ["jurisdiction", "shardMode", "table"] as const) {
        const text = stringProperty(value, key);

        if (text !== undefined) {
            covers[key] = text;
        }
    }

    const memory = findObjectProperty(value, "memory");

    if (Node.isPropertyAssignment(memory) && memory.getInitializer()?.getKind() === SyntaxKind.TrueKeyword) {
        covers.memory = true;
    }

    return Object.keys(covers).length === 0 ? undefined : covers;
};

/** `node` with any wrapping parentheses removed. */
const unparenthesized = (node: Node): Node => (Node.isParenthesizedExpression(node) ? unparenthesized(node.getExpression()) : node);

type UpFunction = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

const isUpFunction = (node: Node): node is UpFunction =>
    Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node);

/**
 * The function an `up` names. A name is followed to its declaration (through an import too) for a few hops; one that cannot be
 * resolved to a function yields `undefined`, which {@link hasIdentityUp} reads as a real transform: the side of "covers" that
 * keeps a migration whose body we cannot read from being called a no-op.
 */
const resolveUpFunction = (node: Node, hops = 4): UpFunction | undefined => {
    const target = unparenthesized(node);

    if (isUpFunction(target)) {
        return target;
    }

    if (hops === 0 || !Node.isIdentifier(target)) {
        return undefined;
    }

    // In `{ up }` the name's own symbol is the property; the value it stands for is the variable.
    const parent = target.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : target.getSymbol();
    const resolved = symbol?.getAliasedSymbol() ?? symbol;
    const declaration = resolved?.getValueDeclaration() ?? resolved?.getDeclarations()[0];

    if (declaration === undefined) {
        return undefined;
    }

    if (Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();

        return initializer === undefined ? undefined : resolveUpFunction(initializer, hops - 1);
    }

    return isUpFunction(declaration) ? declaration : undefined;
};

/**
 * Whether `up` returns its first parameter unchanged — `(document) => document`,
 * `async (doc) => doc`, or a body that is a single `return doc;` — written inline or given by
 * name (a function declared in this file or imported). Anything else, including an `up` that
 * cannot be resolved to a function, is treated as a real transform.
 */
const hasIdentityUp = (object: ObjectLiteralExpression): boolean => {
    const property = findObjectProperty(object, "up");
    let initializer: Node | undefined = property;

    if (Node.isPropertyAssignment(property)) {
        initializer = property.getInitializer();
    } else if (Node.isShorthandPropertyAssignment(property)) {
        initializer = property.getNameNode();
    }

    const up = initializer === undefined ? undefined : resolveUpFunction(initializer);

    if (up === undefined) {
        return false;
    }

    const parameter = up.getParameters()[0]?.getNameNode();

    if (parameter === undefined || !Node.isIdentifier(parameter)) {
        return false;
    }

    const returnsParameter = (expression: Node | undefined): boolean => {
        const returned = expression === undefined ? undefined : unparenthesized(expression);

        return returned !== undefined && Node.isIdentifier(returned) && returned.getText() === parameter.getText();
    };
    const body = up.getBody();

    if (body === undefined) {
        return false;
    }

    if (!Node.isBlock(body)) {
        return returnsParameter(body);
    }

    const [only, ...rest] = body.getStatements();

    return rest.length === 0 && only !== undefined && Node.isReturnStatement(only) && returnsParameter(only.getExpression());
};

/**
 * Lift one `export const x = defineMigration({...})` declaration into
 * {@link MigrationIR}, or `undefined` when it isn't a recognised migration.
 * Throws when a recognised call lacks a static string-literal `id`.
 */
const migrationFromDeclaration = (declaration: VariableDeclaration, relativePath: string): MigrationIR | undefined => {
    const initializer = declaration.getInitializer();

    if (initializer?.getKind() !== SyntaxKind.CallExpression) {
        return undefined;
    }

    const callee = (initializer as CallExpression).getExpression();

    if (!Node.isIdentifier(callee) || !isDefineMigration(callee)) {
        return undefined;
    }

    const argument = (initializer as CallExpression).getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const id = stringProperty(argument, "id");
    const exportName = addressableExportNameOf(declaration, "member");

    if (exportName === undefined) {
        return undefined;
    }

    if (id === undefined || id.trim() === "") {
        throw diagnosticAt(
            argument,
            `Migration "${exportName}" in "${relativePath}" must declare \`id\` as a non-empty string literal so codegen can key the registry.`,
            {
                code: "MIGRATION_ID_NOT_STATIC",
                name: "LunoraError",
                status: 500,
            },
        );
    }

    const covers = coversOf(argument);

    return {
        ...(covers === undefined ? {} : { covers }),
        exportName,
        filePath: relativePath,
        id,
        ...(hasIdentityUp(argument) ? { identity: true as const } : {}),
        table: stringProperty(argument, "table") ?? "",
    };
};

/** Reject duplicate migration ids — the registry keys on `id`, so collisions silently drop a migration. */
const assertUniqueIds = (migrations: ReadonlyArray<MigrationIR>): void => {
    const seenIds = new Map<string, string>();

    for (const migration of migrations) {
        const prior = seenIds.get(migration.id);

        if (prior !== undefined) {
            throw Object.assign(
                new Error(
                    `Duplicate migration id "${migration.id}": declared in both "${prior}" and "${migration.filePath}". Migration ids must be unique across the project.`,
                ),
                { code: "DUPLICATE_MIGRATION_ID", id: migration.id, name: "LunoraError", paths: [prior, migration.filePath], status: 500 },
            );
        }

        seenIds.set(migration.id, migration.filePath);
    }
};

/**
 * Scan all `.ts` files under `lunoraDir` for top-level
 * `export const x = defineMigration({...})` declarations and lift them into
 * {@link MigrationIR}. `id` must be a static string literal (it's the registry
 * key); `table` is best-effort and left `""` when not a literal.
 */
const discoverMigrations = (project: Project, lunoraDirectory: string): MigrationIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const migrations: MigrationIR[] = [];

    for (const filePath of filePaths) {
        // discoverFunctions may have already added these files to the project;
        // reuse the existing SourceFile rather than re-adding (which throws).
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const declaration of exportedVariableDeclarationsOf(source)) {
            const migration = migrationFromDeclaration(declaration, relativePath);

            if (migration) {
                migrations.push(migration);
            }
        }
    }

    migrations.sort((a, b) => a.id.localeCompare(b.id));
    assertUniqueIds(migrations);

    return migrations;
};

export default discoverMigrations;
