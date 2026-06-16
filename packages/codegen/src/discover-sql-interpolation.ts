import type { Node as TsNode, Project, SourceFile, TaggedTemplateExpression } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SqlInterpolationIR } from "./ir";

/**
 * True when `expression` builds a string in place rather than naming a value —
 * the injection smell. A bare identifier / property access / call inside a
 * `ctx.sql` tagged-template `${…}` is auto-parameterized by the Hyperdrive driver
 * and safe; a `BinaryExpression` (`"… " + raw`) or nested template literal splices
 * unparameterized text into the SQL and is the vector we flag.
 */
const isStringBuilding = (expression: TsNode): boolean => Node.isBinaryExpression(expression) || Node.isTemplateExpression(expression);

/** True when `node` is the `ctx.sql` member access (the Hyperdrive tagged-template tag). */
const isContextSql = (node: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(node) || node.getName() !== "sql") {
        return false;
    }

    const receiver = node.getExpression();

    return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
};

/** The export name of the nearest exported `const x = …` ancestor, or `"&lt;module&gt;"` when at file scope. */
const enclosingExportName = (node: TsNode): string => {
    const declaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

    return declaration?.getName() ?? "<module>";
};

/** Risky `${…}` spans inside one `ctx.sql\`…\`` tagged template, as IR rows. */
const interpolationsInTemplate = (tagged: TaggedTemplateExpression, relativePath: string): SqlInterpolationIR[] => {
    const template = tagged.getTemplate();

    if (!Node.isTemplateExpression(template)) {
        return [];
    }

    const found: SqlInterpolationIR[] = [];

    for (const span of template.getTemplateSpans()) {
        const expression = span.getExpression();

        if (isStringBuilding(expression)) {
            found.push({ exportName: enclosingExportName(tagged), file: relativePath, line: expression.getStartLineNumber() });
        }
    }

    return found;
};

/** `ctx.sql` SQL-injection interpolations in one source file. */
const interpolationsInSourceFile = (sourceFile: SourceFile, relativePath: string): SqlInterpolationIR[] => {
    const found: SqlInterpolationIR[] = [];

    for (const tagged of sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
        if (isContextSql(tagged.getTag())) {
            found.push(...interpolationsInTemplate(tagged, relativePath));
        }
    }

    return found;
};

/**
 * Discover `ctx.sql` tagged-template interpolations that splice an unparameterized
 * string-building expression (`"… " + raw`, a nested template literal) into the
 * query — the `sql_injection_risk` lint input. A `${…}` placeholder that simply
 * names a value (`${args.id}`) is bound as a parameter by the Hyperdrive driver
 * and is safe, so only in-place string construction is recorded.
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
