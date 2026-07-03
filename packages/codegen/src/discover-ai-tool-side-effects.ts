import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { calleeName, enclosingExportName, referencesArgs } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { AiToolSideEffectIR } from "./ir";

/** The AI SDK text-generation entrypoints that accept a `tools` map — the injection sink surface. Matched by callee name, `import`-agnostic like the other feeders. */
const GENERATION_CALLEES = new Set(["generateText", "streamText"]);

/** Option keys carrying the model's textual input — the untrusted channel a prompt injection rides in on. */
const MODEL_INPUT_KEYS = new Set(["messages", "prompt", "system"]);

/**
 * Privileged side-effect sinks a tool's `execute` may reach, keyed by the
 * receiver-chain prefix the call must sit on, mapping to the method names that
 * count. A tool that both is model-callable *and* performs one of these is the
 * hazard: the model — steerable by injected instructions in user input — decides
 * whether to fire a real write / dispatch / external send.
 */
const SIDE_EFFECT_SINKS: ReadonlyArray<{ methods: ReadonlySet<string>; prefixes: ReadonlyArray<string> }> = [
    // Database writes.
    { methods: new Set(["delete", "insert", "insertManyUnsafe", "patch", "replace"]), prefixes: ["context.db", "ctx.db"] },
    // Function dispatch (runs another mutation / action with the caller's authority).
    { methods: new Set(["run", "runAction", "runMutation"]), prefixes: ["context", "ctx"] },
    // Outbound network / mail / queue sends.
    { methods: new Set(["fetch"]), prefixes: ["context", "ctx"] },
    { methods: new Set(["queue", "send"]), prefixes: ["context.email", "context.mail", "ctx.email", "ctx.mail"] },
];

/** The privileged side-effect label a call matches (`ctx.db.insert`, `ctx.run`, …), or `undefined` when the call is not a tracked sink. */
const sideEffectLabel = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression().getText();

    for (const sink of SIDE_EFFECT_SINKS) {
        if (sink.methods.has(method) && sink.prefixes.some((prefix) => receiver === prefix || receiver.startsWith(`${prefix}.`))) {
            return `${receiver}.${method}`;
        }
    }

    return undefined;
};

/** The first privileged side-effect label reached inside a `tool({ execute })` construction, or `undefined` when the tool performs none. */
const toolSideEffect = (toolCall: CallExpression): string | undefined => {
    for (const call of toolCall.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const label = sideEffectLabel(call);

        if (label !== undefined) {
            return label;
        }
    }

    return undefined;
};

/**
 * The local binding names destructured from the handler's `args` parameter
 * (`async ({ ctx, args: { text } }) => …` → `{"text"}`) reachable from `node`.
 * The AI SDK's canonical action reads user input through this nested destructure
 * rather than a bare `args.x`, so those names carry taint too.
 */
const destructuredArgumentNames = (node: TsNode): Set<string> => {
    const names = new Set<string>();
    const enclosingFunction = node.getFirstAncestor(
        (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
    );

    const [firstParameter] = enclosingFunction?.getParameters() ?? [];
    const pattern = firstParameter?.getNameNode();

    if (pattern === undefined || !Node.isObjectBindingPattern(pattern)) {
        return names;
    }

    for (const element of pattern.getElements()) {
        const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
        const valueNode = element.getNameNode();

        if (propertyName === "args" && Node.isObjectBindingPattern(valueNode)) {
            for (const nested of valueNode.getElements()) {
                names.add(nested.getName());
            }
        }
    }

    return names;
};

/** True when the model input references the handler's `args` — a bare `args.x` (or one local hop) or a name destructured from `args` (`args: { text }` → `text`). */
const isUserInputDerived = (inputNode: TsNode): boolean => {
    if (referencesArgs(inputNode)) {
        return true;
    }

    const names = destructuredArgumentNames(inputNode);

    if (names.size === 0) {
        return false;
    }

    return inputNode.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => names.has(identifier.getText()));
};

/** True when any of the generation call's model-input options (`prompt` / `messages` / `system`) is derived from user input. */
const hasUserDerivedInput = (optionsObject: ObjectLiteralExpression): boolean => {
    for (const property of optionsObject.getProperties()) {
        if (!Node.isPropertyAssignment(property) || !MODEL_INPUT_KEYS.has(property.getName())) {
            continue;
        }

        const initializer = property.getInitializer();

        if (initializer !== undefined && isUserInputDerived(initializer)) {
            return true;
        }
    }

    return false;
};

/** Every `generateText` / `streamText` call in one source file whose `tools` reach a privileged side effect, tagged with whether the model input is user-derived. */
const generationsInSourceFile = (sourceFile: SourceFile, relativePath: string): AiToolSideEffectIR[] => {
    const rows: AiToolSideEffectIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = calleeName(call.getExpression());

        if (callee === undefined || !GENERATION_CALLEES.has(callee)) {
            continue;
        }

        const [optionsArgument] = call.getArguments();

        if (optionsArgument === undefined || !Node.isObjectLiteralExpression(optionsArgument)) {
            continue;
        }

        let sideEffect: string | undefined;

        for (const toolCall of optionsArgument.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (calleeName(toolCall.getExpression()) !== "tool") {
                continue;
            }

            sideEffect = toolSideEffect(toolCall);

            if (sideEffect !== undefined) {
                break;
            }
        }

        if (sideEffect === undefined) {
            continue;
        }

        rows.push({
            exportName: enclosingExportName(call),
            file: relativePath,
            line: call.getStartLineNumber(),
            method: callee as AiToolSideEffectIR["method"],
            sideEffect,
            userInputDerived: hasUserDerivedInput(optionsArgument),
        });
    }

    return rows;
};

/**
 * Discover `generateText` / `streamText` calls in `lunora/` whose `tools` perform
 * a privileged side effect — the `ai_tool_side_effect_prompt_injection` lint
 * input. When a model-callable `tool({ execute })` writes to the database,
 * dispatches another function, or sends outbound (fetch / mail / queue), the LLM
 * — steerable by injected instructions inside user-supplied prompt / message
 * text — gets to decide whether that real-world action fires. That is the classic
 * confused-deputy prompt-injection hazard.
 *
 * Each row carries the reached `sideEffect` sink and `userInputDerived` — whether
 * the model input (`prompt` / `messages` / `system`) is derived from the handler's
 * `args` (a bare `args.x`, or a name destructured from `args`). The lint fires
 * only when the input is user-derived, so a fully server-authored prompt driving a
 * side-effecting tool is not flagged. Deliberately narrow: only the direct
 * `ctx.*` sink chains and single-hop arg taint are tracked, to hold the
 * false-positive rate down on an inherently heuristic rule.
 */
const discoverAiToolSideEffects = (project: Project, lunoraDirectory: string): AiToolSideEffectIR[] => {
    const rows: AiToolSideEffectIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...generationsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverAiToolSideEffects;
