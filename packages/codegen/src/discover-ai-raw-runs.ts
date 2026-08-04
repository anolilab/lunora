import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { collectCallRows } from "./discover-ast";
import type { AiRawRunIR } from "./ir";

/**
 * True when `node` is a `ctx.ai.run` call callee — the raw Workers AI binding
 * passthrough (`LunoraAi.run`). Matched by shape (a property access named
 * `run` whose receiver TEXT is exactly `ctx.ai`), the same `import`-agnostic,
 * fail-closed convention the other feeders use, so a re-export or alias still
 * resolves.
 */
const isContextAiRunCallee = (node: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(node) || node.getName() !== "run") {
        return false;
    }

    return node.getExpression().getText() === "ctx.ai";
};

/**
 * The IR row for a `ctx.ai.run(model, inputs, options?)` call whose model
 * argument is arg-derived and unscoped, or `undefined`.
 *
 * Only `arguments[0]` (the model id) is inspected — `arguments[1]` (`inputs`)
 * is deliberately never checked, even when it is itself arg-derived: feeding
 * user-supplied text/data to a model is normal, expected usage and would be
 * pure false-positive noise. The narrowing here is "the caller can pick which
 * model runs" (an escape hatch around the typed AI-SDK layer's cap/schema),
 * not "the caller can pick what data goes in".
 */
const aiRawRunInCall = (call: CallExpression, relativePath: string): AiRawRunIR | undefined => {
    if (!isContextAiRunCallee(call.getExpression())) {
        return undefined;
    }

    const model = call.getArguments()[0];

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a model id built from `ctx.config.model`
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!model || !isArgumentDerived(model) || isScopedByContext(model)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber() };
};

/**
 * Discover `ctx.ai.run(model, …)` calls in `lunora/` whose model-id argument is
 * derived from the handler's `args` with no server-side scoping — the
 * `ai_raw_run_escape_hatch` lint input. `ctx.ai.run` is the raw Workers AI
 * binding passthrough, bypassing the typed `ctx.ai.model(...)` + AI-SDK layer
 * (`generateText`/`streamText`/…) entirely — no output cap, no schema. When the
 * model id comes straight from request input, any caller can select an
 * arbitrary model, sidestepping whatever the typed path would have enforced. A
 * fixed literal model, or one scoped by a server-trusted `ctx.*` value, is not
 * recorded; only an arg-derived, unscoped model id (directly, or through one
 * local `const` hop) reaches here. The `inputs` argument is never inspected —
 * see {@link aiRawRunInCall}.
 */
const discoverAiRawRuns = (project: Project, lunoraDirectory: string): AiRawRunIR[] => collectCallRows(project, lunoraDirectory, aiRawRunInCall);

export default discoverAiRawRuns;
