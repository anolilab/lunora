import { existsSync } from "node:fs";
import { join } from "node:path";

import { agentBindingName, agentClassName, agentDefaultName } from "@lunora/agent";
import type { CallExpression, Expression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { AgentIR } from "./ir";

/** The only file agents may be declared in — mirrors `lunora/workflows.ts`. */
const AGENTS_FILENAME = "agents.ts";

/**
 * Decide whether a callee identifier refers to `defineAgent` from
 * `@lunora/agent`. Mirrors `isDefineWorkflow`: trust the import declaration when
 * the checker has a symbol (so aliasing survives), and fall back to the surface
 * text when no symbol is available.
 */
const isDefineAgent = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineAgent";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@lunora/agent") {
            return false;
        }

        return declaration.getNameNode().getText() === "defineAgent";
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
        `agent "${exportName}": \`${property}\` must be a static string literal — it is deploy configuration codegen writes into wrangler.jsonc`,
    );
};

/** Lift one exported `defineAgent({...})` declaration into {@link AgentIR}. */
const agentFromCall = (call: CallExpression, exportName: string): AgentIR => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(call, `agent "${exportName}": defineAgent must be passed an inline object literal`);
    }

    const ir: AgentIR = {
        bindingName: agentBindingName(exportName),
        className: agentClassName(exportName),
        exportName,
        name: agentDefaultName(exportName),
    };

    const nameProperty = argument.getProperty("name");

    if (nameProperty && Node.isPropertyAssignment(nameProperty)) {
        ir.name = stringProperty(nameProperty.getInitializerOrThrow(), exportName, "name");
    }

    return ir;
};

/**
 * Collect exported `defineAgent` declarations from one source file. Apps never
 * re-export the runtime component functions (codegen auto-registers them), but
 * a hand-written `export const { agentAppendMessage } = agentComponent().functions`
 * must not break discovery either — its initializer is a property access, not a
 * `CallExpression`, so the guard below skips it and only `defineAgent()` calls
 * are lifted.
 */
const agentsFromSource = (source: SourceFile): AgentIR[] => {
    const agents: AgentIR[] = [];

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

        if (!Node.isIdentifier(callee) || !isDefineAgent(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineAgent exports must be plain named exports (no destructuring)");
        }

        agents.push(agentFromCall(call, nameNode.getText()));
    }

    return agents;
};

/**
 * Discover every agent the project declares: exported `defineAgent()` calls in
 * `lunora/agents.ts`. Returns `[]` when the file doesn't exist. The only
 * wrangler-relevant literal is the optional `name` override; the agent config
 * (model / tools / memory) is runtime-only, so codegen never evaluates it.
 */
const discoverAgents = (project: Project, lunoraDirectory: string): AgentIR[] => {
    const agentsPath = join(lunoraDirectory, AGENTS_FILENAME);

    if (!existsSync(agentsPath)) {
        return [];
    }

    const source = project.getSourceFile(agentsPath) ?? project.addSourceFileAtPath(agentsPath);
    const agents = agentsFromSource(source);

    agents.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return agents;
};

export { AGENTS_FILENAME, discoverAgents };
