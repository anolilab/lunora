import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SqlInterpolationIR } from "./ir";

/** The `SqlClient` methods that splice their first (`text`) argument verbatim into the query. */
const SQL_TEXT_METHODS = new Set(["query", "unsafe"]);

/**
 * True when `node` is a `ctx.sql.query` / `ctx.sql.unsafe` member access — the
 * Hyperdrive `SqlClient` text-running methods. `ctx.sql` is NOT a tagged-template
 * function; it's an object whose `query`/`unsafe` methods bind ONLY the `params`
 * array, splicing the `text` argument verbatim into the SQL. So the real injection
 * sink is the first argument to these calls, not a tagged-template span.
 */
const isContextSqlTextCallee = (node: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(node) || !SQL_TEXT_METHODS.has(node.getName())) {
        return false;
    }

    const sqlAccess = node.getExpression();

    if (!Node.isPropertyAccessExpression(sqlAccess) || sqlAccess.getName() !== "sql") {
        return false;
    }

    const receiver = sqlAccess.getExpression();

    return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
};

/**
 * True when `expression` builds a SQL string in place rather than naming a bound
 * value — the injection smell for the `text` argument. A `BinaryExpression`
 * (`"… " + raw`) or a `TemplateExpression` (a template literal *with* substitution
 * spans) splices unparameterized text into the query; a plain string literal or a
 * no-substitution template (`\`SELECT 1\``) is a fixed, safe statement and is not
 * flagged. The `params` array — bound by the driver — is never inspected.
 */
const isStringBuildingText = (expression: TsNode): boolean => Node.isBinaryExpression(expression) || Node.isTemplateExpression(expression);

/** The export name of the nearest exported `const x = …` ancestor, or `"<module>"` when at file scope. */
const enclosingExportName = (node: TsNode): string => {
    const declaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

    return declaration?.getName() ?? "<module>";
};

/** The IR row for a `ctx.sql.query(text, …)` / `.unsafe(text, …)` call whose `text` is string-built, or `undefined`. */
const interpolationInCall = (call: CallExpression, relativePath: string): SqlInterpolationIR | undefined => {
    if (!isContextSqlTextCallee(call.getExpression())) {
        return undefined;
    }

    const text = call.getArguments()[0];

    if (!text || !isStringBuildingText(text)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: text.getStartLineNumber() };
};

/** `ctx.sql.query`/`ctx.sql.unsafe` SQL-injection interpolations in one source file. */
const interpolationsInSourceFile = (sourceFile: SourceFile, relativePath: string): SqlInterpolationIR[] => {
    const found: SqlInterpolationIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const interpolation = interpolationInCall(call, relativePath);

        if (interpolation) {
            found.push(interpolation);
        }
    }

    return found;
};

/**
 * Discover `ctx.sql.query(text, …)` / `ctx.sql.unsafe(text, …)` calls whose `text`
 * argument is built in place from a string concatenation or a substitution
 * template literal — the `sql_injection_risk` lint input. The Hyperdrive driver
 * binds ONLY the `params` array; the `text` string is spliced verbatim into the
 * SQL (`client.query(text, params)` / `client.unsafe(text, params)`), so a `text`
 * assembled from request input is a textbook injection vector. A fixed string
 * literal or a no-substitution template is a safe statement and is not recorded.
 */
const discoverSqlInterpolation = (project: Project, lunoraDirectory: string): SqlInterpolationIR[] => {
    const interpolations: SqlInterpolationIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        interpolations.push(...interpolationsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return interpolations;
};

export default discoverSqlInterpolation;
