import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { workflowBindingName, workflowClassName, workflowDefaultName } from "@lunora/workflow";
import type { CallExpression, Expression, Identifier, ObjectLiteralExpression, Project, PropertyAccessExpression, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { WorkflowIR, WorkflowStepIR } from "./ir";

/** The only file workflows may be declared in — mirrors `lunora/containers.ts`. */
const WORKFLOWS_FILENAME = "workflows.ts";

/** The native durable-step methods whose first string argument names a memoized step. */
const STEP_METHODS = new Set(["do", "sleep", "sleepUntil", "waitForEvent"]);

/**
 * Decide whether a callee identifier refers to `defineWorkflow` from
 * `@lunora/workflow`. Mirrors `isDefineContainer`: trust the import declaration
 * when the checker has a symbol (so aliasing survives), and fall back to the
 * surface text when no symbol is available.
 */
const isDefineWorkflow = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineWorkflow";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@lunora/workflow") {
            return false;
        }

        return declaration.getNameNode().getText() === "defineWorkflow";
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
        `workflow "${exportName}": \`${property}\` must be a static string literal — it is deploy configuration codegen writes into wrangler.jsonc`,
    );
};

/**
 * True when a call expression is a native durable-step invocation —
 * `ctx.step.do(...)`, `ctx.step.sleep(...)`, etc., or a destructured
 * `step.do(...)`. Matches on the `.step.method` / `step.method` shape rather
 * than the receiver identity, so a renamed/destructured context still resolves.
 */
const isStepCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !STEP_METHODS.has(callee.getName())) {
        return false;
    }

    const receiver = callee.getExpression();

    // `<x>.step.<method>(...)` — receiver is a `.step` property access.
    if (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "step") {
        return true;
    }

    // `const { step } = ctx; step.<method>(...)` — receiver is a bare `step`.
    return Node.isIdentifier(receiver) && receiver.getText() === "step";
};

/**
 * Lift the durable step labels from a workflow's `handler` body — the first
 * string-literal argument of each native step call. Steps named by a non-literal
 * (a variable, template with substitutions) are omitted: they can't be compared
 * for duplication statically. A shorthand/external handler (no inline body) yields
 * `[]`. Order follows source order so the lint's "first wins" is deterministic.
 */
const stepsFromHandler = (argument: ObjectLiteralExpression): WorkflowStepIR[] => {
    const handlerProperty = argument.getProperty("handler");

    if (!handlerProperty) {
        return [];
    }

    const body = Node.isPropertyAssignment(handlerProperty) ? handlerProperty.getInitializer() : handlerProperty;

    if (!body) {
        return [];
    }

    const steps: WorkflowStepIR[] = [];

    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isStepCall(call)) {
            continue;
        }

        const nameArgument = call.getArguments()[0];

        if (!nameArgument || !(Node.isStringLiteral(nameArgument) || Node.isNoSubstitutionTemplateLiteral(nameArgument))) {
            continue;
        }

        steps.push({
            line: call.getStartLineNumber(),
            // `isStepCall` already proved the callee is a `.<method>` property access.
            method: (call.getExpression() as PropertyAccessExpression).getName(),
            name: nameArgument.getLiteralValue(),
        });
    }

    return steps;
};

/** Lift one exported `defineWorkflow({...})` declaration into {@link WorkflowIR}. */
const workflowFromCall = (call: CallExpression, exportName: string): WorkflowIR => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(call, `workflow "${exportName}": defineWorkflow must be passed an inline object literal`);
    }

    const ir: WorkflowIR = {
        bindingName: workflowBindingName(exportName),
        className: workflowClassName(exportName),
        exportName,
        name: workflowDefaultName(exportName),
        steps: stepsFromHandler(argument),
    };

    const nameProperty = argument.getProperty("name");

    if (nameProperty && Node.isPropertyAssignment(nameProperty)) {
        ir.name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");
    }

    return ir;
};

/**
 * Unwrap `as`/`satisfies`/parenthesized wrappers around a call expression —
 * `defineWorkflow({...}) satisfies WorkflowDefinition`, `defineWorkflow({...}) as const`,
 * or `(defineWorkflow({...}))` — down to the inner `CallExpression`. Mirrors the
 * identical helper in `discover-agents.ts`. Returns `undefined` when the
 * (possibly wrapped) node isn't ultimately a call.
 */
const unwrapToCallExpression = (node: Node | undefined): CallExpression | undefined => {
    let current: Node | undefined = node;

    while (current && (Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isParenthesizedExpression(current))) {
        current = current.getExpression();
    }

    return current && Node.isCallExpression(current) ? current : undefined;
};

/**
 * Collect exported `defineWorkflow` declarations from one source file. A
 * `defineWorkflow({...})` initializer may be wrapped in `as`/`satisfies`/parens
 * — {@link unwrapToCallExpression} sees through those to the inner call.
 */
const workflowsFromSource = (source: SourceFile): WorkflowIR[] => {
    const workflows: WorkflowIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const call = unwrapToCallExpression(declaration.getInitializer());

        if (!call) {
            continue;
        }

        const callee = call.getExpression();

        if (!Node.isIdentifier(callee) || !isDefineWorkflow(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineWorkflow exports must be plain named exports (no destructuring)");
        }

        workflows.push(workflowFromCall(call, nameNode.getText()));
    }

    return workflows;
};

/**
 * Reject workflows whose deployed `name` or `bindingName` collide across exports
 * — both flow into wrangler (`workflows[].name` / the `Workflow` binding), so a
 * `name` collision emits conflicting `workflows[]` entries and a `bindingName`
 * collision (e.g. `myFlow`/`myFLOW` both → `WORKFLOW_MY_FLOW`) clobbers a
 * binding. Mirrors the cron/migration uniqueness guards.
 */
const assertUniqueNames = (workflows: ReadonlyArray<WorkflowIR>): void => {
    const seenNames = new Map<string, string>();
    const seenBindings = new Map<string, string>();

    for (const workflow of workflows) {
        const priorName = seenNames.get(workflow.name);

        if (priorName !== undefined) {
            throw new LunoraError(
                // eslint-disable-next-line no-secrets/no-secrets -- an error code, not a secret
                "DUPLICATE_WORKFLOW_NAME",
                `Duplicate workflow name "${workflow.name}": produced by both "${priorName}" and "${workflow.exportName}". Deployed workflow names must be unique across the project.`,
                { status: 500 },
            );
        }

        seenNames.set(workflow.name, workflow.exportName);

        const priorBinding = seenBindings.get(workflow.bindingName);

        if (priorBinding !== undefined) {
            throw new LunoraError(
                // eslint-disable-next-line no-secrets/no-secrets -- an error code, not a secret
                "DUPLICATE_WORKFLOW_BINDING",
                `Duplicate workflow binding "${workflow.bindingName}": produced by both "${priorBinding}" and "${workflow.exportName}". Workflow export names must yield unique binding names.`,
                { status: 500 },
            );
        }

        seenBindings.set(workflow.bindingName, workflow.exportName);
    }
};

/**
 * Discover every workflow the project declares: exported `defineWorkflow()`
 * calls in `lunora/workflows.ts`. Returns `[]` when the file doesn't exist. The
 * only wrangler-relevant literal is the optional `name` override; the workflow
 * body is runtime-only, so codegen never evaluates it.
 */
const discoverWorkflows = (project: Project, lunoraDirectory: string): WorkflowIR[] => {
    const workflowsPath = join(lunoraDirectory, WORKFLOWS_FILENAME);

    if (!existsSync(workflowsPath)) {
        return [];
    }

    const source = project.getSourceFile(workflowsPath) ?? project.addSourceFileAtPath(workflowsPath);
    const workflows = workflowsFromSource(source);

    workflows.sort((a, b) => a.exportName.localeCompare(b.exportName));
    assertUniqueNames(workflows);

    return workflows;
};

export { discoverWorkflows, WORKFLOWS_FILENAME };
