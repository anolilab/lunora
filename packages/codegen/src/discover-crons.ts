import { compileCronSchedule, CRON_SCHEDULE_KINDS, isValidCronExpression } from "@cirrus/scheduler";
import type { CallExpression, Identifier, ObjectLiteralExpression, Project, PropertyAccessExpression, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions.js";
import type { CronJobIR } from "./ir.js";
import sanitizeNamespace from "./paths.js";

/** All builder method names — the structured schedules plus the raw `.cron`. */
const CRON_METHODS = new Set<string>([...CRON_SCHEDULE_KINDS, "cron"]);

/**
 * Decide whether a callee identifier refers to `@cirrus/scheduler`'s
 * `cronJobs`. Mirrors `isDefineMigration`: trust the import declaration when the
 * checker has a symbol (so aliasing survives), and fall back to the surface text
 * when no symbol is available (no tsconfig wired up).
 */
const isCronJobsFactory = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "cronJobs";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@cirrus/scheduler") {
            return false;
        }

        return declaration.getNameNode().getText() === "cronJobs";
    }

    return false;
};

/** Collect the set of local identifiers bound to a `cronJobs()` call in this file. */
const collectCronBuilderNames = (source: SourceFile): Set<string> => {
    const names = new Set<string>();

    for (const declaration of source.getVariableDeclarations()) {
        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const callee = (initializer as CallExpression).getExpression();

        if (Node.isIdentifier(callee) && isCronJobsFactory(callee)) {
            names.add(declaration.getName());
        }
    }

    return names;
};

/** Walk a property-access chain leftward to its root identifier (e.g. `crons` in `crons.a().b`). */
const rootIdentifierOf = (node: Node): string | undefined => {
    let current: Node = node;

    while (Node.isCallExpression(current) || Node.isPropertyAccessExpression(current)) {
        current = current.getExpression();
    }

    return Node.isIdentifier(current) ? current.getText() : undefined;
};

/** Read a static string-literal argument, or undefined when it isn't a literal. */
const stringArgument = (call: CallExpression, index: number): string | undefined => {
    const argument = call.getArguments()[index];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : undefined;
};

/** Evaluate a literal AST node into a plain JS value, or throw for unsupported forms. */
const literalValue = (node: Node, jobName: string): unknown => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return node.getLiteralValue();
    }

    if (Node.isNumericLiteral(node)) {
        return node.getLiteralValue();
    }

    if (Node.isTrueLiteral(node)) {
        return true;
    }

    if (Node.isFalseLiteral(node)) {
        return false;
    }

    if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken) {
        const operand = node.getOperand();

        if (Node.isNumericLiteral(operand)) {
            return -operand.getLiteralValue();
        }
    }

    if (Node.isObjectLiteralExpression(node)) {
        // `objectLiteralValue` and `literalValue` are mutually recursive; the
        // forward reference is resolved at call time, not definition time.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion
        return objectLiteralValue(node, jobName);
    }

    if (Node.isArrayLiteralExpression(node)) {
        return node.getElements().map((element) => literalValue(element, jobName));
    }

    throw Object.assign(new Error(`Cron job "${jobName}" passes a non-static value where a literal is required; codegen can only read literals.`), {
        code: "CRON_NON_STATIC_VALUE",
        name: "CirrusError",
        status: 500,
    });
};

/** Lift an object literal into a plain record of literal values. */
const objectLiteralValue = (object: ObjectLiteralExpression, jobName: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            throw Object.assign(
                new Error(`Cron job "${jobName}" uses an unsupported object property (shorthand/spread/method) where a static literal is required.`),
                {
                    code: "CRON_NON_STATIC_VALUE",
                    name: "CirrusError",
                    status: 500,
                },
            );
        }

        const initializer = property.getInitializer();

        if (initializer) {
            result[property.getName()] = literalValue(initializer, jobName);
        }
    }

    return result;
};

/** Resolve `internal.email.digest` / `api.foo.bar` → the `namespace:fn` ref the runtime dispatches on. */
const functionPathFromArgument = (call: CallExpression, index: number, jobName: string): string => {
    const argument = call.getArguments()[index];

    if (!argument || !Node.isPropertyAccessExpression(argument)) {
        throw Object.assign(
            new Error(`Cron job "${jobName}" must reference a function statically (e.g. internal.email.digest); codegen cannot resolve a dynamic reference.`),
            {
                code: "CRON_NON_STATIC_FN",
                name: "CirrusError",
                status: 500,
            },
        );
    }

    // `root.namespace.fn` → `${namespace}:${fn}`. The leading root
    // (`internal`/`api`) is dropped; namespaces are sanitized exactly as
    // `emitApi`/`emitServer`/the anyApi proxy do, so the ref matches dispatch.
    const functionName = argument.getName();
    const receiver = argument.getExpression();

    if (!Node.isPropertyAccessExpression(receiver)) {
        throw Object.assign(new Error(`Cron job "${jobName}" function reference must be of the form internal.file.fn (two property accesses).`), {
            code: "CRON_NON_STATIC_FN",
            name: "CirrusError",
            status: 500,
        });
    }

    const namespace = receiver.getName();

    return `${sanitizeNamespace(namespace)}:${functionName}`;
};

/** Lift one `crons.method(name, schedule, fnRef, args?)` call into {@link CronJobIR}. */
const cronFromCall = (call: CallExpression, callee: PropertyAccessExpression, builderNames: Set<string>): CronJobIR | undefined => {
    const method = callee.getName();

    if (!CRON_METHODS.has(method)) {
        return undefined;
    }

    if (!builderNames.has(rootIdentifierOf(callee.getExpression()) ?? "")) {
        return undefined;
    }

    const name = stringArgument(call, 0);

    if (name === undefined || name.trim() === "") {
        throw Object.assign(new Error(`A cron ".${method}(...)" registration must pass a non-empty string-literal name as its first argument.`), {
            code: "CRON_NAME_NOT_STATIC",
            name: "CirrusError",
            status: 500,
        });
    }

    let cron: string;

    if (method === "cron") {
        const expression = stringArgument(call, 1);

        if (expression === undefined) {
            throw Object.assign(new Error(`Cron job "${name}" must pass a string-literal cron expression to ".cron(...)".`), {
                code: "CRON_EXPR_NOT_STATIC",
                name: "CirrusError",
                status: 500,
            });
        }

        if (!isValidCronExpression(expression)) {
            throw Object.assign(new Error(`Cron job "${name}" has an invalid cron expression "${expression}" — expected 5 or 6 space-separated fields.`), {
                code: "CRON_EXPR_INVALID",
                name: "CirrusError",
                status: 500,
            });
        }

        cron = expression;
    } else {
        const scheduleArgument = call.getArguments()[1];

        if (!scheduleArgument || !Node.isObjectLiteralExpression(scheduleArgument)) {
            throw Object.assign(new Error(`Cron job "${name}" must pass an object-literal schedule to ".${method}(...)".`), {
                code: "CRON_SCHEDULE_NOT_STATIC",
                name: "CirrusError",
                status: 500,
            });
        }

        cron = compileCronSchedule(method as "daily" | "interval" | "monthly" | "weekly", objectLiteralValue(scheduleArgument, name));
    }

    const functionPath = functionPathFromArgument(call, 2, name);
    const argumentsNode = call.getArguments()[3];
    const args = argumentsNode && Node.isObjectLiteralExpression(argumentsNode) ? objectLiteralValue(argumentsNode, name) : {};

    return { args, cron, functionPath, name };
};

/** Reject duplicate cron job names — runtime keys the dispatcher by name. */
const assertUniqueNames = (crons: ReadonlyArray<CronJobIR>): void => {
    const seen = new Map<string, string>();

    for (const cron of crons) {
        const prior = seen.get(cron.name);

        if (prior !== undefined) {
            throw Object.assign(
                new Error(
                    `Duplicate cron job name "${cron.name}": declared in both "${prior}" and the same set. Cron names must be unique across the project.`,
                ),
                {
                    code: "DUPLICATE_CRON_NAME",
                    name: "CirrusError",
                    names: cron.name,
                    status: 500,
                },
            );
        }

        seen.set(cron.name, cron.name);
    }
};

/**
 * Scan every `.ts` file under `cirrusDir` for `cronJobs()` builder registrations
 * (`crons.interval(...)`, `crons.daily(...)`, `crons.cron(...)`, …) and lift them
 * into {@link CronJobIR}. Schedules are compiled to standard cron expressions;
 * function references are resolved to their `namespace:fn` dispatch path. Names
 * must be unique across the project.
 */
const discoverCrons = (project: Project, cirrusDirectory: string): CronJobIR[] => {
    const filePaths = listCirrusSourceFiles(cirrusDirectory);
    const crons: CronJobIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const builderNames = collectCronBuilderNames(source);

        if (builderNames.size === 0) {
            continue;
        }

        for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression();

            if (!Node.isPropertyAccessExpression(callee)) {
                continue;
            }

            const cron = cronFromCall(call, callee, builderNames);

            if (cron) {
                crons.push(cron);
            }
        }
    }

    crons.sort((a, b) => a.name.localeCompare(b.name));
    assertUniqueNames(crons);

    return crons;
};

export default discoverCrons;
