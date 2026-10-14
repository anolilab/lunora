import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { queueBindingName, queueDefaultName } from "@lunora/queue";
import type { CallExpression, Expression, Identifier, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { QueueIR, TopicIR } from "../ir";
import { findObjectProperty, lunoraRelativePath, stringPropertyFor } from "./ast";
import { addressableExportNameOf } from "./attribution";
import { resolveHandlerReference } from "./handler-reference";
import { discoverModules } from "./modules";

/** The file queues are declared in: `lunora/queues.ts`, and the same name directly inside a module folder. */
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
 * Cloudflare's accepted range for each numeric consumer setting
 * (developers.cloudflare.com/queues/platform/limits). Checked here so an
 * out-of-range value fails at codegen, pointing at the source, rather than at
 * `wrangler deploy`. `maxBatchTimeout` is in seconds and may be fractional.
 */
const TUNING_RANGES = {
    maxBatchSize: { integer: true, max: 100, min: 1 },
    maxBatchTimeout: { integer: false, max: 60, min: 0 },
    maxConcurrency: { integer: true, max: 250, min: 1 },
    maxRetries: { integer: true, max: 100, min: 0 },
    retryDelay: { integer: true, max: 86_400, min: 0 },
} as const;

/** Read each numeric consumer setting, range-checked against {@link TUNING_RANGES}. */
const readNumericTuning = (argument: ObjectLiteralExpression, exportName: string): QueueIR["tuning"] => {
    const tuning: QueueIR["tuning"] = {};

    for (const [property, range] of Object.entries(TUNING_RANGES) as [keyof typeof TUNING_RANGES, (typeof TUNING_RANGES)[keyof typeof TUNING_RANGES]][]) {
        const node = findObjectProperty(argument, property);

        if (node && Node.isPropertyAssignment(node)) {
            const value = numberProperty(node.getInitializerOrThrow(), exportName, property);

            if (value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) {
                throw diagnosticAt(
                    node,
                    `queue "${exportName}": \`${property}\` must be ${range.integer ? "an integer" : "a number"} from ${range.min.toString()} to ${range.max.toString()} (got ${value.toString()})`,
                );
            }

            tuning[property] = value;
        }
    }

    return tuning;
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
    const handlerSite = resolveHandlerReference(findObjectProperty(argument, "handler"), lunoraDirectory)?.site;
    const ir: QueueIR = {
        bindingName: queueBindingName(exportName),
        exportName,
        filePath: lunoraRelativePath(lunoraDirectory, argument.getSourceFile().getFilePath()),
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

    Object.assign(ir.tuning, readNumericTuning(argument, exportName));

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

/** The key a topic is registered under: its declaring file plus its local binding name. */
const topicKey = (filePath: string, localName: string): string => `${filePath}:${localName}`;

/**
 * The {@link topicKey} of the binding an identifier refers to, following an
 * import to its declaration so a module can subscribe to a topic another queues
 * file declares. Falls back to the identifier's own file when the checker
 * resolves nothing.
 */
const topicKeyOf = (identifier: Identifier): string => {
    const symbol = identifier.getSymbol();
    const declaration = (symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol)?.getDeclarations()[0];

    return declaration !== undefined && Node.isVariableDeclaration(declaration)
        ? topicKey(declaration.getSourceFile().getFilePath(), declaration.getName())
        : topicKey(identifier.getSourceFile().getFilePath(), identifier.getText());
};

/**
 * Lift one exported `defineSubscription(topic, {...})` into the push {@link QueueIR}
 * it deploys as. The topic must be an identifier naming a `defineTopic` export of
 * a queues file (this one, or one it imports from) — that is what lets codegen
 * wire `ctx.topics.<topic>` to this subscription's binding without evaluating anything.
 */
const subscriptionFromCall = (call: CallExpression, exportName: string, topics: ReadonlyMap<string, string>, lunoraDirectory: string): QueueIR => {
    const [topicArgument, configArgument] = call.getArguments();
    const topic = topicArgument !== undefined && Node.isIdentifier(topicArgument) ? topics.get(topicKeyOf(topicArgument)) : undefined;

    if (topic === undefined) {
        throw diagnosticAt(
            topicArgument ?? call,
            `subscription "${exportName}": the first argument must name a \`defineTopic()\` export of lunora/queues.ts or a module's queues.ts`,
        );
    }

    if (!configArgument || !Node.isObjectLiteralExpression(configArgument)) {
        throw diagnosticAt(call, `subscription "${exportName}": defineSubscription must be passed an inline object literal`);
    }

    return queueFromConfig(configArgument, exportName, topic, lunoraDirectory);
};

/** One exported `define*(...)` call in `lunora/queues.ts`. */
interface FactoryExport {
    call: CallExpression;
    exportName: string;
    factory: QueueFactory;
    /** The binding name in the module, which a subscription passes as its topic. */
    localName: string;
}

/** Every exported `@lunora/queue` factory call in one source file, in source order. */
const factoryExports = (source: SourceFile): FactoryExport[] => {
    const found: FactoryExport[] = [];

    for (const declaration of source.getVariableDeclarations()) {
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

        // Only the `export` keyword can export a destructuring; an unexported one is a local.
        if (!Node.isIdentifier(nameNode)) {
            if (declaration.getVariableStatement()?.hasExportKeyword() !== true) {
                continue;
            }

            throw diagnosticAt(nameNode, `${factory} exports must be plain named exports (no destructuring)`);
        }

        const exportName = addressableExportNameOf(declaration, "binding");

        if (exportName === undefined) {
            continue;
        }

        found.push({ call, exportName, factory, localName: nameNode.getText() });
    }

    return found;
};

/**
 * Reject an export name two queues files share. The name is the `ctx.queues` /
 * `ctx.topics` key, the binding name and the import name in `_generated/`, so it
 * has to be unique across the app, not just within one file.
 */
const assertUniqueExportNames = (exports: ReadonlyArray<FactoryExport>, lunoraDirectory: string): void => {
    const seen = new Map<string, string>();

    for (const entry of exports) {
        const file = lunoraRelativePath(lunoraDirectory, entry.call.getSourceFile().getFilePath());
        const prior = seen.get(entry.exportName);

        if (prior !== undefined) {
            throw diagnosticAt(
                entry.call,
                `"${entry.exportName}" is exported by both lunora/${prior}.ts and lunora/${file}.ts — queue and topic export names must be unique across the app`,
            );
        }

        seen.set(entry.exportName, file);
    }
};

/** Collect the queues (subscriptions included) and topics a set of queues files declares. */
const queuesFromSources = (sources: ReadonlyArray<SourceFile>, lunoraDirectory: string): { queues: QueueIR[]; topics: TopicIR[] } => {
    const exports = sources.flatMap((source) => factoryExports(source));

    assertUniqueExportNames(exports, lunoraDirectory);

    // A subscription names its topic by a local or imported binding; the topic registers under its exported name.
    const topicEntries = exports.filter((entry) => entry.factory === "defineTopic");
    const topicNames = new Map(topicEntries.map((entry) => [topicKey(entry.call.getSourceFile().getFilePath(), entry.localName), entry.exportName] as const));
    const queues: QueueIR[] = [];

    for (const entry of exports) {
        if (entry.factory === "defineQueue") {
            queues.push(queueFromCall(entry.call, entry.exportName, lunoraDirectory));
        } else if (entry.factory === "defineSubscription") {
            queues.push(subscriptionFromCall(entry.call, entry.exportName, topicNames, lunoraDirectory));
        }
    }

    const topics = topicEntries.map((entry): TopicIR => {
        return { exportName: entry.exportName, filePath: lunoraRelativePath(lunoraDirectory, entry.call.getSourceFile().getFilePath()) };
    });

    return { queues, topics };
};

/** `lunora/queues.ts` and each declared module's `<module>/queues.ts`, those that exist. */
const queueFilesIn = (project: Project, lunoraDirectory: string): string[] =>
    [
        join(lunoraDirectory, QUEUES_FILENAME),
        ...discoverModules(project, lunoraDirectory).map((entry) => join(lunoraDirectory, entry.name, QUEUES_FILENAME)),
    ].filter((path) => existsSync(path));

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
 * Discover what `lunora/queues.ts` and each module's `queues.ts` declare, in one
 * parse: the queues (`defineQueue` and `defineSubscription` exports — a
 * subscription deploys as a push queue carrying `topic`) and the `defineTopic`
 * exports. Both are `[]` when no such file exists. Only the wrangler-relevant
 * literals (`name`/`mode`/batch tuning) are read; handler bodies are
 * runtime-only, so codegen never evaluates them.
 */
const discoverQueueDeclarations = (project: Project, lunoraDirectory: string): { queues: QueueIR[]; topics: TopicIR[] } => {
    // Every file is added before any is read, so a subscription's imported topic resolves.
    const sources = queueFilesIn(project, lunoraDirectory).map((path) => project.getSourceFile(path) ?? project.addSourceFileAtPath(path));
    const { queues, topics } = queuesFromSources(sources, lunoraDirectory);
    const sortedQueues = queues.toSorted((a, b) => a.exportName.localeCompare(b.exportName));

    assertUniqueNames(sortedQueues);

    return { queues: sortedQueues, topics: topics.toSorted((a, b) => a.exportName.localeCompare(b.exportName)) };
};

/** The queues half of {@link discoverQueueDeclarations} — what the config layer reconciles into wrangler. */
const discoverQueues = (project: Project, lunoraDirectory: string): QueueIR[] => discoverQueueDeclarations(project, lunoraDirectory).queues;

export { discoverQueueDeclarations, discoverQueues, QUEUES_FILENAME };
