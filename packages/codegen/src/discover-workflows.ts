import { existsSync } from "node:fs";
import { join } from "node:path";

import { workflowBindingName, workflowClassName, workflowDefaultName } from "@lunora/workflow";
import type { CallExpression, Expression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { WorkflowIR } from "./ir";

/** The only file workflows may be declared in — mirrors `lunora/containers.ts`. */
const WORKFLOWS_FILENAME = "workflows.ts";

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
    };

    const nameProperty = argument.getProperty("name");

    if (nameProperty && Node.isPropertyAssignment(nameProperty)) {
        ir.name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");
    }

    return ir;
};

/** Collect exported `defineWorkflow` declarations from one source file. */
const workflowsFromSource = (source: SourceFile): WorkflowIR[] => {
    const workflows: WorkflowIR[] = [];

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

    return workflows;
};

export { discoverWorkflows, WORKFLOWS_FILENAME };
