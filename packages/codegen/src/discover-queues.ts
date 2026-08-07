import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { queueBindingName, queueDefaultName } from "@lunora/queue";
import type { CallExpression, Expression, Identifier, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { stringPropertyFor } from "./discover-ast";
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
const stringProperty = stringPropertyFor("queue");

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

/**
 * Resolve an explicit `name` override, or `undefined` when none is declared.
 * Mirrors the runtime `defineQueue` guard: an empty `name` would flow into the
 * registry key and the reconciled wrangler queue name, so it is rejected here
 * with a located diagnostic rather than failing downstream validation.
 */
const queueNameOverride = (argument: ObjectLiteralExpression, exportName: string): string | undefined => {
    const nameProperty = argument.getProperty("name");

    if (!nameProperty || !Node.isPropertyAssignment(nameProperty)) {
        return undefined;
    }

    const name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");

    if (name.length === 0) {
        throw diagnosticAt(nameProperty, `queue "${exportName}": \`name\` must be a non-empty string when provided`);
    }

    return name;
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
        name: queueNameOverride(argument, exportName) ?? queueDefaultName(exportName),
        tuning: {},
    };

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
 * Reject queues whose deployed `name` or `bindingName` collide across exports —
 * both flow into wrangler (`queues.producers[]`/`consumers[]`) and the
 * `LUNORA_QUEUE_REGISTRY` object literal, so a `name` collision emits conflicting
 * wrangler entries (push+pull) or a duplicate registry key (TS1117), and a
 * `bindingName` collision (e.g. `myQueue`/`myQUEUE` both → `QUEUE_MY_QUEUE`)
 * clobbers a producer binding. Mirrors the cron/migration uniqueness guards.
 */
const assertUniqueNames = (queues: ReadonlyArray<QueueIR>): void => {
    const seenNames = new Map<string, string>();
    const seenBindings = new Map<string, string>();

    for (const queue of queues) {
        const priorName = seenNames.get(queue.name);

        if (priorName !== undefined) {
            throw new LunoraError(
                "DUPLICATE_QUEUE_NAME",
                `Duplicate queue name "${queue.name}": produced by both "${priorName}" and "${queue.exportName}". Deployed queue names must be unique across the project.`,
                { status: 500 },
            );
        }

        seenNames.set(queue.name, queue.exportName);

        const priorBinding = seenBindings.get(queue.bindingName);

        if (priorBinding !== undefined) {
            throw new LunoraError(
                "DUPLICATE_QUEUE_BINDING",
                `Duplicate queue binding "${queue.bindingName}": produced by both "${priorBinding}" and "${queue.exportName}". Queue export names must yield unique binding names.`,
                { status: 500 },
            );
        }

        seenBindings.set(queue.bindingName, queue.exportName);
    }
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
    assertUniqueNames(queues);

    return queues;
};

export { discoverQueues, QUEUES_FILENAME };
