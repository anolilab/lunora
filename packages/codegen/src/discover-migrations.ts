import type { CallExpression, Identifier, ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { lunoraRelativePath } from "./discover-ast";
import { listLunoraSourceFiles } from "./discover-functions";
import type { MigrationIR } from "./ir";
import { isServerPackageModule } from "./module-specifiers";

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
    const property = object.getProperty(name);

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
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
    const exportName = declaration.getName();

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

    return { exportName, filePath: relativePath, id, table: stringProperty(argument, "table") ?? "" };
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

        for (const statement of source.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const migration = migrationFromDeclaration(declaration, relativePath);

                if (migration) {
                    migrations.push(migration);
                }
            }
        }
    }

    migrations.sort((a, b) => a.id.localeCompare(b.id));
    assertUniqueIds(migrations);

    return migrations;
};

export default discoverMigrations;
