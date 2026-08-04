import { existsSync } from "node:fs";
import { join } from "node:path";

// The /naming subpath keeps codegen from loading the agent runtime (and the
// AI SDK behind it) just to derive deploy names.
import { agentBindingName, agentClassName, agentDefaultName, voiceBindingName, voiceClassName } from "@lunora/agent/naming";
import { LunoraError } from "@lunora/errors";
import type { CallExpression, Expression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { stringPropertyFor, unwrapToCallExpression } from "./discover-ast";
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
const stringProperty = stringPropertyFor("agent");

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

    // Opt-in to inbound email (`defineAgent({ onEmail })`). `onEmail` is a runtime
    // closure the emitter never evaluates — its mere presence (in any property
    // form: assignment, shorthand, or method) tells codegen to wire this agent
    // onto the worker's `email()` handler. Carried onto IR only when present, so
    // email-free agents stay byte-identical.
    if (argument.getProperty("onEmail")) {
        ir.onEmail = true;
    }

    return ir;
};

/**
 * Collect exported `defineAgent` declarations from one source file. Apps never
 * re-export the runtime component functions (codegen auto-registers them), but
 * a hand-written `export const { agentAppendMessage } = agentComponent().functions`
 * must not break discovery either — its initializer is a property access, not a
 * `CallExpression` (nor a wrapped one), so it's skipped and only `defineAgent()`
 * calls (optionally wrapped in `as`/`satisfies`/parens) are lifted.
 */
const agentsFromSource = (source: SourceFile): AgentIR[] => {
    const agents: AgentIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const call = unwrapToCallExpression(declaration.getInitializer());

        if (!call) {
            continue;
        }

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
 * Reject agents whose deployed `name`, `bindingName`, or `className` collide
 * across exports — all three flow into wrangler/generated output (`workflows[].name`,
 * the `AGENT_*` Workflow binding, and the `_generated/agents.ts` class), and agent
 * naming case-folds (`supportBot`/`SupportBot` both derive `AGENT_SUPPORT_BOT`), so a
 * collision on any one of them silently clobbers a binding or a generated class.
 * Mirrors `discover-workflows.ts`'s `assertUniqueNames`, extended with `className`.
 */
const assertUniqueNames = (agents: ReadonlyArray<AgentIR>): void => {
    const seenNames = new Map<string, string>();
    const seenBindings = new Map<string, string>();
    const seenClasses = new Map<string, string>();

    for (const agent of agents) {
        const priorName = seenNames.get(agent.name);

        if (priorName !== undefined) {
            throw new LunoraError(
                "DUPLICATE_AGENT_NAME",
                `Duplicate agent name "${agent.name}": produced by both "${priorName}" and "${agent.exportName}". Deployed agent names must be unique across the project.`,
                { status: 500 },
            );
        }

        seenNames.set(agent.name, agent.exportName);

        const priorBinding = seenBindings.get(agent.bindingName);

        if (priorBinding !== undefined) {
            throw new LunoraError(
                "DUPLICATE_AGENT_BINDING",
                `Duplicate agent binding "${agent.bindingName}": produced by both "${priorBinding}" and "${agent.exportName}". Agent export names must yield unique binding names.`,
                { status: 500 },
            );
        }

        seenBindings.set(agent.bindingName, agent.exportName);

        const priorClass = seenClasses.get(agent.className);

        if (priorClass !== undefined) {
            throw new LunoraError(
                "DUPLICATE_AGENT_CLASS",
                `Duplicate agent class "${agent.className}": produced by both "${priorClass}" and "${agent.exportName}". Agent export names must yield unique generated class names.`,
                { status: 500 },
            );
        }

        seenClasses.set(agent.className, agent.exportName);
    }
};

/**
 * Discover every agent the project declares: exported `defineAgent()` calls in
 * `lunora/agents.ts`. Returns `[]` when the file doesn't exist. Only four things
 * are read statically — the optional `name` override (wrangler `workflows[].name`),
 * the optional `publicRun` opt-in (the `agents:agentRun` capability gate), the
 * presence of a `voice` block (which turns on the voice-session Durable Object),
 * and the presence of an `onEmail` mapper (which wires the worker `email()`
 * handler); the rest of the agent config (model / tools / memory / voice models /
 * the `onEmail` closure body) is runtime-only, so codegen never evaluates it.
 */
const discoverAgents = (project: Project, lunoraDirectory: string): AgentIR[] => {
    const agentsPath = join(lunoraDirectory, AGENTS_FILENAME);

    if (!existsSync(agentsPath)) {
        return [];
    }

    const source = project.getSourceFile(agentsPath) ?? project.addSourceFileAtPath(agentsPath);
    const agents = agentsFromSource(source);

    agents.sort((a, b) => a.exportName.localeCompare(b.exportName));
    assertUniqueNames(agents);

    return agents;
};

export { AGENTS_FILENAME, discoverAgents };
