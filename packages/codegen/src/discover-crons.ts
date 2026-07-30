import { LunoraError } from "@lunora/errors";
import type { CronScheduleKind } from "@lunora/scheduler";
import { compileCronSchedule, CRON_SCHEDULE_KINDS, isValidCronExpression } from "@lunora/scheduler";
import type { CallExpression, Identifier, ObjectLiteralExpression, Project, PropertyAccessExpression, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { listLunoraSourceFiles } from "./discover-functions";
import type { AgentIR, CronJobIR, WorkflowIR } from "./ir";
import { isCronSourceModule } from "./module-specifiers";
import sanitizeNamespace from "./paths";

/** All builder method names — the structured schedules plus the raw `.cron`. */
const CRON_METHODS = new Set<string>([...CRON_SCHEDULE_KINDS, "cron"]);

/**
 * Decide whether a callee identifier refers to the framework's `cronJobs` —
 * imported from `@lunora/scheduler` (its home), `@lunora/server` (which
 * re-exports it), or `lunorash/server` (the same through the umbrella). An
 * unrecognized specifier drops every cron silently: `_generated/crons.ts` is not
 * emitted at all, so the schedule never fires.
 *
 * Mirrors `isDefineMigration`: trust the import declaration when the checker has
 * a symbol (so aliasing survives), and fall back to the surface text when no
 * symbol is available (no tsconfig wired up).
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

        if (!isCronSourceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
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

    return argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) ? argument.getLiteralValue() : undefined;
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

    throw diagnosticAt(node, `Cron job "${jobName}" passes a non-static value where a literal is required; codegen can only read literals.`, {
        code: "CRON_NON_STATIC_VALUE",
        name: "LunoraError",
        status: 500,
    });
};

/** Lift an object literal into a plain record of literal values. */
const objectLiteralValue = (object: ObjectLiteralExpression, jobName: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            throw diagnosticAt(
                property,
                `Cron job "${jobName}" uses an unsupported object property (shorthand/spread/method) where a static literal is required.`,
                {
                    code: "CRON_NON_STATIC_VALUE",
                    name: "LunoraError",
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
        throw diagnosticAt(
            call,
            `Cron job "${jobName}" must reference a function statically (e.g. internal.email.digest); codegen cannot resolve a dynamic reference.`,
            {
                code: "CRON_NON_STATIC_FN",
                name: "LunoraError",
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
        throw diagnosticAt(argument, `Cron job "${jobName}" function reference must be of the form internal.file.fn (two property accesses).`, {
            code: "CRON_NON_STATIC_FN",
            name: "LunoraError",
            status: 500,
        });
    }

    const namespace = receiver.getName();

    return `${sanitizeNamespace(namespace)}:${functionName}`;
};

/** Build a workflow target IR from a resolved {@link WorkflowIR}. */
const workflowTarget = (workflow: WorkflowIR): Pick<CronJobIR, "workflow"> => {
    return { workflow: { binding: workflow.bindingName, exportName: workflow.exportName } };
};

/**
 * Build a workflow target IR from a resolved {@link AgentIR}. An agent compiles
 * onto a Cloudflare Workflow (its `AGENT_*` binding IS a Workflow binding), so a
 * cron that targets it rides the exact same durable-workflow start path as a
 * `workflows.NAME` target — the runtime cron dispatcher calls `.create()` on the
 * binding per fire, and the agent's flat `AgentRunInput` args become the run
 * params.
 */
const agentTarget = (agent: AgentIR): Pick<CronJobIR, "workflow"> => {
    return { workflow: { binding: agent.bindingName, exportName: agent.exportName } };
};

/**
 * Resolve a `RECEIVER.NAME` property access (`workflows.NAME` / `agents.NAME`)
 * against a discovered-definitions map into a workflow-start target. Returns
 * `undefined` when the receiver identifier isn't `receiverName` (so the caller
 * can try the next receiver, then fall through to function dispatch); throws a
 * located diagnostic when the receiver matches but names no declared definition.
 */
const resolveReferenceAccess = <Definition>(
    argument: PropertyAccessExpression,
    receiverName: string,
    byName: ReadonlyMap<string, Definition>,
    jobName: string,
    kind: "agent" | "workflow",
    build: (definition: Definition) => Pick<CronJobIR, "workflow">,
): Pick<CronJobIR, "workflow"> | undefined => {
    const receiver = argument.getExpression();

    if (!Node.isIdentifier(receiver) || receiver.getText() !== receiverName) {
        return undefined;
    }

    const definition = byName.get(argument.getName());

    if (definition) {
        return build(definition);
    }

    throw diagnosticAt(
        argument,
        `Cron job "${jobName}" targets ${receiverName}.${argument.getName()}, but no such ${kind} is declared in lunora/${kind}s.ts.`,
        {
            code: "CRON_NON_STATIC_FN",
            name: "LunoraError",
            status: 500,
        },
    );
};

/**
 * Resolve the cron's target argument into either a function dispatch
 * (`{ functionPath }`) or a durable-workflow start
 * (`{ workflow: { binding, exportName } }`).
 *
 * Targets mirror the generated reference objects in `_generated/api.ts`: a
 * `workflows.NAME` access is the canonical generated workflow reference; an
 * `agents.NAME` access is the generated agent reference (an agent run is a
 * workflow instance); a bare `NAME` identifier is a `defineWorkflow` export
 * imported directly; and an `internal.file.fn` / `api.file.fn` access is a
 * function dispatch.
 *
 * A `workflows.NAME` / `agents.NAME` / bare identifier that doesn't name a
 * declared workflow (or agent), or anything else, is a static-resolution error.
 */
const resolveTarget = (
    call: CallExpression,
    index: number,
    jobName: string,
    workflowsByName: ReadonlyMap<string, WorkflowIR>,
    agentsByName: ReadonlyMap<string, AgentIR>,
): Pick<CronJobIR, "functionPath" | "workflow"> => {
    const argument = call.getArguments()[index];

    // Canonical workflow/agent targets: `workflows.NAME` / `agents.NAME` — the
    // generated reference objects. The receiver is a bare identifier (a single
    // property access), which distinguishes it from a `internal.file.fn` function
    // ref (a double access whose receiver is itself a property access).
    if (argument && Node.isPropertyAccessExpression(argument)) {
        const workflowReference = resolveReferenceAccess(argument, "workflows", workflowsByName, jobName, "workflow", workflowTarget);

        if (workflowReference) {
            return workflowReference;
        }

        const agentReference = resolveReferenceAccess(argument, "agents", agentsByName, jobName, "agent", agentTarget);

        if (agentReference) {
            return agentReference;
        }

        return { functionPath: functionPathFromArgument(call, index, jobName) };
    }

    // Workflow/agent target via a bare identifier referencing a `defineWorkflow`
    // export (e.g. `digestPipeline` imported from `./workflows`) or a
    // `defineAgent` export (e.g. `support` imported from `./agents`).
    if (argument && Node.isIdentifier(argument)) {
        const workflow = workflowsByName.get(argument.getText());
        const agent = agentsByName.get(argument.getText());

        // Both maps can hold the same export name (e.g. a `defineWorkflow` and a
        // `defineAgent` both named `support`, imported into the same file under
        // one local identifier). Blindly preferring the workflow lookup here would
        // silently target the wrong definition when the identifier actually came
        // from `agents.ts` — fail closed instead of guessing.
        if (workflow && agent) {
            throw diagnosticAt(
                argument,
                `Cron job "${jobName}" references "${argument.getText()}", which is ambiguous: a workflow and an agent are both declared under that name.`,
                {
                    code: "CRON_NON_STATIC_FN",
                    name: "LunoraError",
                    status: 500,
                },
            );
        }

        if (workflow) {
            return workflowTarget(workflow);
        }

        if (agent) {
            return agentTarget(agent);
        }

        throw diagnosticAt(
            argument,
            `Cron job "${jobName}" references "${argument.getText()}", which is neither a function (internal.file.fn / api.file.fn) nor a declared workflow in lunora/workflows.ts nor a declared agent in lunora/agents.ts.`,
            {
                code: "CRON_NON_STATIC_FN",
                name: "LunoraError",
                status: 500,
            },
        );
    }

    return { functionPath: functionPathFromArgument(call, index, jobName) };
};

/** Lift one `crons.method(name, schedule, fnRef, args?)` call into {@link CronJobIR}. */
const cronFromCall = (
    call: CallExpression,
    callee: PropertyAccessExpression,
    builderNames: Set<string>,
    workflowsByName: ReadonlyMap<string, WorkflowIR>,
    agentsByName: ReadonlyMap<string, AgentIR>,
): CronJobIR | undefined => {
    const method = callee.getName();

    if (!CRON_METHODS.has(method)) {
        return undefined;
    }

    if (!builderNames.has(rootIdentifierOf(callee.getExpression()) ?? "")) {
        return undefined;
    }

    const name = stringArgument(call, 0);

    if (name === undefined || name.trim() === "") {
        throw diagnosticAt(call, `A cron ".${method}(...)" registration must pass a non-empty string-literal name as its first argument.`, {
            code: "CRON_NAME_NOT_STATIC",
            name: "LunoraError",
            status: 500,
        });
    }

    let cron: string;

    if (method === "cron") {
        const expression = stringArgument(call, 1);

        if (expression === undefined) {
            throw diagnosticAt(call, `Cron job "${name}" must pass a string-literal cron expression to ".cron(...)".`, {
                code: "CRON_EXPR_NOT_STATIC",
                name: "LunoraError",
                status: 500,
            });
        }

        if (!isValidCronExpression(expression)) {
            throw diagnosticAt(call, `Cron job "${name}" has an invalid cron expression "${expression}" — expected 5 or 6 space-separated fields.`, {
                code: "CRON_EXPR_INVALID",
                name: "LunoraError",
                status: 500,
            });
        }

        cron = expression;
    } else {
        const scheduleArgument = call.getArguments()[1];

        if (!scheduleArgument || !Node.isObjectLiteralExpression(scheduleArgument)) {
            throw diagnosticAt(call, `Cron job "${name}" must pass an object-literal schedule to ".${method}(...)".`, {
                code: "CRON_SCHEDULE_NOT_STATIC",
                name: "LunoraError",
                status: 500,
            });
        }

        cron = compileCronSchedule(method as CronScheduleKind, objectLiteralValue(scheduleArgument, name));
    }

    const target = resolveTarget(call, 2, name, workflowsByName, agentsByName);
    const argumentsNode = call.getArguments()[3];
    const args = argumentsNode && Node.isObjectLiteralExpression(argumentsNode) ? objectLiteralValue(argumentsNode, name) : {};

    return { args, cron, name, ...target };
};

/** Reject duplicate cron job names — runtime keys the dispatcher by name. */
const assertUniqueNames = (crons: ReadonlyArray<CronJobIR>): void => {
    const seen = new Set<string>();

    for (const cron of crons) {
        if (seen.has(cron.name)) {
            throw new LunoraError("DUPLICATE_CRON_NAME", `Duplicate cron job name "${cron.name}": cron names must be unique across the project.`, {
                status: 500,
            });
        }

        seen.add(cron.name);
    }
};

/**
 * Scan every `.ts` file under `lunoraDir` for `cronJobs()` builder registrations
 * (`crons.interval(...)`, `crons.daily(...)`, `crons.cron(...)`, …) and lift them
 * into {@link CronJobIR}. Schedules are compiled to standard cron expressions;
 * function references are resolved to their `namespace:fn` dispatch path, while a
 * `workflows.NAME` / `agents.NAME` reference (or a bare identifier naming a
 * declared workflow) resolves to a durable workflow start. Names must be unique
 * across the project.
 */
const discoverCrons = (
    project: Project,
    lunoraDirectory: string,
    workflows: ReadonlyArray<WorkflowIR> = [],
    agents: ReadonlyArray<AgentIR> = [],
): CronJobIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const crons: CronJobIR[] = [];
    const workflowsByName = new Map<string, WorkflowIR>(workflows.map((workflow) => [workflow.exportName, workflow]));
    const agentsByName = new Map<string, AgentIR>(agents.map((agent) => [agent.exportName, agent]));

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

            const cron = cronFromCall(call, callee, builderNames, workflowsByName, agentsByName);

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
