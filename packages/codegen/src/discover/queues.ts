import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { queueBindingName, queueDefaultName } from "@lunora/queue";
import type { CallExpression, Expression, Identifier, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { QueueIR, TopicIR } from "../ir";
import { findObjectProperty, handlerDeclarationOf, handlerSiteOf, stringPropertyFor } from "./ast";

/** The only file queues may be declared in — mirrors `lunora/workflows.ts`. */
const QUEUES_FILENAME = "queues.ts";

/** The `@lunora/queue` factories `lunora/queues.ts` declares with. */
type QueueFactory = "defineQueue" | "defineSubscription" | "defineTopic";

/**
 * Decide which `@lunora/queue` factory a callee identifier refers to, if any.
 * Mirrors `isDefineWorkflow`: trust the import declaration when the checker has
 * a symbol (so aliasing survives), and fall back to the surface text when no
 * symbol is available.
 */
const queueFactoryOf = (identifier: Identifier): QueueFactory | undefined => {
    const isFactory = (name: string): name is QueueFactory => name === "defineQueue" || name === "defineSubscription" || name === "defineTopic";
    const symbol = identifier.getSymbol();

    if (!symbol) {
        const text = identifier.getText();

        return isFactory(text) ? text : undefined;
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@lunora/queue") {
            return undefined;
        }

        const imported = declaration.getNameNode().getText();

        return isFactory(imported) ? imported : undefined;
    }

    return undefined;
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
    const nameProperty = findObjectProperty(argument, "name");

    if (!nameProperty || !Node.isPropertyAssignment(nameProperty)) {
        return undefined;
    }

    const name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");

    if (name.length === 0) {
        throw diagnosticAt(nameProperty, `queue "${exportName}": \`name\` must be a non-empty string when provided`);
    }

    return name;
};

/**
 * Lift a queue's config object literal into {@link QueueIR} — the second argument
 * of `defineSubscription(topic, {...})` is the same shape as `defineQueue({...})`
 * minus `mode` (a subscription is always a push consumer).
 */
const queueFromConfig = (argument: ObjectLiteralExpression, exportName: string, topic: string | undefined, lunoraDirectory: string): QueueIR => {
    // `handler: processEmail` imported from another file: its call sites belong to this queue.
    const handlerSite = handlerSiteOf(handlerDeclarationOf(findObjectProperty(argument, "handler")), lunoraDirectory);
    const ir: QueueIR = {
        bindingName: queueBindingName(exportName),
        exportName,
        mode: "push",
        name: queueNameOverride(argument, exportName) ?? queueDefaultName(exportName),
        ...(topic === undefined ? {} : { topic }),
        ...(handlerSite === undefined ? {} : { handlerSite }),
        tuning: {},
    };

    const modeProperty = findObjectProperty(argument, "mode");

    if (modeProperty && Node.isPropertyAssignment(modeProperty)) {
        if (topic !== undefined) {
            throw diagnosticAt(modeProperty, `subscription "${exportName}": \`mode\` is not allowed — a subscription is always a push consumer`);
        }

        const mode = stringProperty(modeProperty.getInitializerOrThrow(), exportName, "mode");

        if (mode !== "push" && mode !== "pull") {
            throw diagnosticAt(modeProperty, `queue "${exportName}": \`mode\` must be "push" or "pull" (got ${JSON.stringify(mode)})`);
        }

        ir.mode = mode;
    }

    const dlqProperty = findObjectProperty(argument, "deadLetterQueue");

    if (dlqProperty && Node.isPropertyAssignment(dlqProperty)) {
        ir.tuning.deadLetterQueue = stringProperty(dlqProperty.getInitializerOrThrow(), exportName, "deadLetterQueue");
    }

    for (const property of ["maxBatchSize", "maxBatchTimeout", "maxRetries", "retryDelay"] as const) {
        const node = findObjectProperty(argument, property);

        if (node && Node.isPropertyAssignment(node)) {
            ir.tuning[property] = numberProperty(node.getInitializerOrThrow(), exportName, property);
        }
    }

    return ir;
};

/** Lift one exported `defineQueue({...})` declaration into {@link QueueIR}. */
const queueFromCall = (call: CallExpression, exportName: string, lunoraDirectory: string): QueueIR => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(call, `queue "${exportName}": defineQueue must be passed an inline object literal`);
    }

    return queueFromConfig(argument, exportName, undefined, lunoraDirectory);
};

/**
 * Lift one exported `defineSubscription(topic, {...})` into the push {@link QueueIR}
 * it deploys as. The topic must be an identifier naming a `defineTopic` export of
 * the same file — that is what lets codegen wire `ctx.topics.<topic>` to this
 * subscription's binding without evaluating anything.
 */
const subscriptionFromCall = (call: CallExpression, exportName: string, topics: ReadonlySet<string>, lunoraDirectory: string): QueueIR => {
    const [topicArgument, configArgument] = call.getArguments();

    if (!topicArgument || !Node.isIdentifier(topicArgument) || !topics.has(topicArgument.getText())) {
        throw diagnosticAt(topicArgument ?? call, `subscription "${exportName}": the first argument must name a \`defineTopic()\` export of lunora/queues.ts`);
    }

    if (!configArgument || !Node.isObjectLiteralExpression(configArgument)) {
        throw diagnosticAt(call, `subscription "${exportName}": defineSubscription must be passed an inline object literal`);
    }

    return queueFromConfig(configArgument, exportName, topicArgument.getText(), lunoraDirectory);
};

/** One exported `define*(...)` call in `lunora/queues.ts`. */
interface FactoryExport {
    call: CallExpression;
    exportName: string;
    factory: QueueFactory;
}

/** Every exported `@lunora/queue` factory call in one source file, in source order. */
const factoryExports = (source: SourceFile): FactoryExport[] => {
    const found: FactoryExport[] = [];

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
        const factory = Node.isIdentifier(callee) ? queueFactoryOf(callee) : undefined;

        if (factory === undefined) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, `${factory} exports must be plain named exports (no destructuring)`);
        }

        found.push({ call, exportName: nameNode.getText(), factory });
    }

    return found;
};

/** Collect the queues (subscriptions included) and topics one source file declares. */
const queuesFromSource = (source: SourceFile, lunoraDirectory: string): { queues: QueueIR[]; topics: TopicIR[] } => {
    const exports = factoryExports(source);
    const topicNames = new Set(exports.filter((entry) => entry.factory === "defineTopic").map((entry) => entry.exportName));
    const queues: QueueIR[] = [];

    for (const entry of exports) {
        if (entry.factory === "defineQueue") {
            queues.push(queueFromCall(entry.call, entry.exportName, lunoraDirectory));
        } else if (entry.factory === "defineSubscription") {
            queues.push(subscriptionFromCall(entry.call, entry.exportName, topicNames, lunoraDirectory));
        }
    }

    const topics = [...topicNames].map((exportName) => {
        return { exportName };
    });

    return { queues, topics };
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
 * Discover what `lunora/queues.ts` declares, in one parse: the queues
 * (`defineQueue` and `defineSubscription` exports — a subscription deploys as a
 * push queue carrying `topic`) and the `defineTopic` exports. Both are `[]` when
 * the file doesn't exist. Only the wrangler-relevant literals (`name`/`mode`/batch
 * tuning) are read; handler bodies are runtime-only, so codegen never evaluates them.
 */
const discoverQueueDeclarations = (project: Project, lunoraDirectory: string): { queues: QueueIR[]; topics: TopicIR[] } => {
    const queuesPath = join(lunoraDirectory, QUEUES_FILENAME);

    if (!existsSync(queuesPath)) {
        return { queues: [], topics: [] };
    }

    const source = project.getSourceFile(queuesPath) ?? project.addSourceFileAtPath(queuesPath);
    const { queues, topics } = queuesFromSource(source, lunoraDirectory);
    const sortedQueues = queues.toSorted((a, b) => a.exportName.localeCompare(b.exportName));

    assertUniqueNames(sortedQueues);

    return { queues: sortedQueues, topics: topics.toSorted((a, b) => a.exportName.localeCompare(b.exportName)) };
};

/** The queues half of {@link discoverQueueDeclarations} — what the config layer reconciles into wrangler. */
const discoverQueues = (project: Project, lunoraDirectory: string): QueueIR[] => discoverQueueDeclarations(project, lunoraDirectory).queues;

export { discoverQueueDeclarations, discoverQueues, QUEUES_FILENAME };
