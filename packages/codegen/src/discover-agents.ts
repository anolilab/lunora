import { existsSync } from "node:fs";
import { join } from "node:path";

// The /naming subpath keeps codegen from loading the agent runtime (and the
// AI SDK behind it) just to derive deploy names.
import { agentBindingName, agentClassName, agentDefaultName, voiceBindingName, voiceClassName } from "@lunora/agent/naming";
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

/** Read a property's boolean-literal value, or throw a located diagnostic. */
const booleanProperty = (expression: Expression, exportName: string, property: string): boolean => {
    if (expression.getKind() === SyntaxKind.TrueKeyword) {
        return true;
    }

    if (expression.getKind() === SyntaxKind.FalseKeyword) {
        return false;
    }

    throw diagnosticAt(
        expression,
        `agent "${exportName}": \`${property}\` must be a static boolean literal — it is deploy configuration codegen writes into the ctx.agents wiring spec`,
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

    // Opt-in to public run-starts (`agents:agentRun`). Only a `true` literal is
    // carried onto IR — `false`/absent stays undefined so the emitted spec (and
    // agent-free output) is byte-identical.
    const publicRunProperty = argument.getProperty("publicRun");

    if (
        publicRunProperty &&
        Node.isPropertyAssignment(publicRunProperty) &&
        booleanProperty(publicRunProperty.getInitializerOrThrow(), exportName, "publicRun")
    ) {
        ir.publicRun = true;
    }

    // Opt-in to a real-time voice session. Presence of a `voice` block (any object
    // literal) turns on the hibernatable-WebSocket DO; the block's fields are
    // runtime config the DO reads, so codegen keys only on presence, not contents.
    // Only carried onto IR when present, so voice-free agents stay byte-identical.
    const voiceProperty = argument.getProperty("voice");

    if (voiceProperty && Node.isPropertyAssignment(voiceProperty)) {
        const voiceInitializer = voiceProperty.getInitializerOrThrow();

        if (!Node.isObjectLiteralExpression(voiceInitializer)) {
            throw diagnosticAt(
                voiceInitializer,
                `agent "${exportName}": \`voice\` must be an inline object literal — its presence tells codegen to emit the voice-session Durable Object`,
            );
        }

        ir.voice = true;
        ir.voiceBindingName = voiceBindingName(exportName);
        ir.voiceClassName = voiceClassName(exportName);
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
 * `lunora/agents.ts`. Returns `[]` when the file doesn't exist. Only three things
 * are read statically — the optional `name` override (wrangler `workflows[].name`),
 * the optional `publicRun` opt-in (the `agents:agentRun` capability gate), and the
 * presence of a `voice` block (which turns on the voice-session Durable Object);
 * the rest of the agent config (model / tools / memory / voice models) is
 * runtime-only, so codegen never evaluates it.
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
