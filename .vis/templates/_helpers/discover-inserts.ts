/**
 * Write-side discovery (the analog of the advisor's read discovery): scan the
 * `cirrus/` function files for `ctx.db.insert("<table>", …)` calls and attribute
 * each table to the exported function (and its file = api namespace) that inserts
 * into it. Lets the `cirrus-collections` generator wire a table's write action by
 * what the mutation *does*, not by a naming convention.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

export interface InsertMutationRef {
    /** The exported function name (e.g. `send`). */
    name: string;
    /** The file basename = api namespace (e.g. `messages`). */
    namespace: string;
}

/** The function factories whose handlers may contain a `ctx.db.insert(...)`. */
const FUNCTION_FACTORIES = new Set(["action", "mutation", "query"]);

/**
 * Map `table → { namespace, name }` for every table some exported function
 * inserts into. The first inserter found for a table wins. Returns an empty map
 * if the directory can't be read.
 */
export const discoverInsertMutations = (cirrusDir: string): Map<string, InsertMutationRef> => {
    const attribution = new Map<string, InsertMutationRef>();

    let files: string[];

    try {
        files = readdirSync(cirrusDir).filter((file) => file.endsWith(".ts") && file !== "schema.ts");
    } catch {
        return attribution;
    }

    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });

    for (const file of files) {
        const namespace = file.replace(/\.ts$/u, "");
        let source: string;

        try {
            source = readFileSync(join(cirrusDir, file), "utf8");
        } catch {
            continue;
        }

        const sourceFile = project.createSourceFile(`${namespace}.ts`, source, { overwrite: true });

        for (const declaration of sourceFile.getVariableDeclarations()) {
            if (declaration.getVariableStatement()?.hasExportKeyword() !== true) {
                continue;
            }

            const initializer = declaration.getInitializer();

            if (initializer?.getKind() !== SyntaxKind.CallExpression) {
                continue;
            }

            if (!FUNCTION_FACTORIES.has((initializer as CallExpression).getExpression().getText())) {
                continue;
            }

            const name = declaration.getName();

            // Any `…​.db.insert("<table>", …)` call inside this exported function.
            for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                const callee = call.getExpression();

                if (callee.getKind() !== SyntaxKind.PropertyAccessExpression || !callee.getText().endsWith(".db.insert")) {
                    continue;
                }

                const tableArgument = call.getArguments()[0];

                if (tableArgument?.getKind() !== SyntaxKind.StringLiteral) {
                    continue;
                }

                const table = tableArgument.getText().replaceAll(/["']/g, "");

                if (!attribution.has(table)) {
                    attribution.set(table, { name, namespace });
                }
            }
        }
    }

    return attribution;
};
