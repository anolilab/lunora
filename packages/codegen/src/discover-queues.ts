import { existsSync } from "node:fs";
import { join } from "node:path";

import { queueBindingName, queueDefaultName } from "@lunora/queue";
import type { CallExpression, Expression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { QueueIR } from "./ir";

/** The only file queues may be declared in — mirrors `lunora/workflows.ts`. */
const QUEUES_FILENAME = "queues.ts";

/**
 * Decide whether a callee identifier refers to `defineQueue` from
 * `@lunora/queue`. Mirrors `isDefineWorkflow`: trust the import declaration when
 * the checker has a symbol (so aliasing survives), and fall back to the surface
 * text when no symbol is available.
 */
const isDefineQueue = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineQueue";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@lunora/queue") {
            return false;
        }

        return declaration.getNameNode().getText() === "defineQueue";
    }

    return false;
};

/** Read a property's string-literal value, or throw a located diagnostic. */
const stringProperty = (expression: Expression, exportName: string, property: string): string => {
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.getLiteralValue();
    }

    throw diagnosticAt(
        expression,
        `queue "${exportName}": \`${property}\` must be a static string literal — it is deploy configuration codegen writes into wrangler.jsonc`,
    );
};

/** Read a property's numeric-literal value, or throw a located diagnostic. */
const numberProperty = (expression: Expression, exportName: string, property: string): number => {
    if (Node.isNumericLiteral(expression)) {
        return expression.getLiteralValue();
    }

    throw diagnosticAt(
        expression,
        `queue "${exportName}": \`${property}\` must be a static numeric literal — it is deploy configuration codegen writes into wrangler.jsonc`,
    );
};

/** Lift one exported `defineQueue({...})` declaration into {@link QueueIR}. */
const queueFromCall = (call: CallExpression, exportName: string): QueueIR => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(call, `queue "${exportName}": defineQueue must be passed an inline object literal`);
    }

    const ir: QueueIR = {
        bindingName: queueBindingName(exportName),
        exportName,
        mode: "push",
        name: queueDefaultName(exportName),
        tuning: {},
    };

    const nameProperty = argument.getProperty("name");

    if (nameProperty && Node.isPropertyAssignment(nameProperty)) {
        ir.name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");
    }

    const modeProperty = argument.getProperty("mode");

    if (modeProperty && Node.isPropertyAssignment(modeProperty)) {
        const mode = stringProperty(modeProperty.getInitializerOrThrow(), exportName, "mode");

        if (mode !== "push" && mode !== "pull") {
            throw diagnosticAt(modeProperty, `queue "${exportName}": \`mode\` must be "push" or "pull" (got ${JSON.stringify(mode)})`);
        }

        ir.mode = mode;
    }

    const dlqProperty = argument.getProperty("deadLetterQueue");

    if (dlqProperty && Node.isPropertyAssignment(dlqProperty)) {
        ir.tuning.deadLetterQueue = stringProperty(dlqProperty.getInitializerOrThrow(), exportName, "deadLetterQueue");
    }

    for (const property of ["maxBatchSize", "maxBatchTimeout", "maxRetries", "retryDelay"] as const) {
        const node = argument.getProperty(property);

        if (node && Node.isPropertyAssignment(node)) {
            ir.tuning[property] = numberProperty(node.getInitializerOrThrow(), exportName, property);
        }
    }

    return ir;
};

/** Collect exported `defineQueue` declarations from one source file. */
const queuesFromSource = (source: SourceFile): QueueIR[] => {
    const queues: QueueIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const call = initializer as CallExpression;
        const callee = call.getExpression();

        if (!Node.isIdentifier(callee) || !isDefineQueue(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineQueue exports must be plain named exports (no destructuring)");
        }

        queues.push(queueFromCall(call, nameNode.getText()));
    }

    return queues;
};

/**
 * Discover every queue the project declares: exported `defineQueue()` calls in
 * `lunora/queues.ts`. Returns `[]` when the file doesn't exist. Only the
 * wrangler-relevant literals (`name`/`mode`/batch tuning) are read; the handler
 * body is runtime-only, so codegen never evaluates it.
 */
const discoverQueues = (project: Project, lunoraDirectory: string): QueueIR[] => {
    const queuesPath = join(lunoraDirectory, QUEUES_FILENAME);

    if (!existsSync(queuesPath)) {
        return [];
    }

    const source = project.getSourceFile(queuesPath) ?? project.addSourceFileAtPath(queuesPath);
    const queues = queuesFromSource(source);

    queues.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return queues;
};

export { discoverQueues, QUEUES_FILENAME };
