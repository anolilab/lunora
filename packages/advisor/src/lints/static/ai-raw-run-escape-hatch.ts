import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.ai.run(model, …)` call whose model-id argument is derived from
 * the handler's `args` with no server-side scoping — arbitrary model
 * selection that bypasses the typed AI-SDK layer.
 *
 * `ctx.ai.run` is the raw Workers AI binding passthrough (void-style
 * `ai.run`), bypassing `ctx.ai.model(...)` plus the AI SDK functions
 * (`generateText`, `streamText`, …) entirely — no output cap, no schema. When
 * the model id comes straight from request input (`ctx.ai.run(args.model,
 * …)`, or one built one hop earlier from `args`), any caller can pick which
 * model runs, sidestepping whatever the typed path would have enforced. Only
 * the model argument (`arguments[0]`) is inspected; an arg-derived `inputs`
 * (`arguments[1]`) is normal, expected usage and is never flagged. A model
 * scoped by a server-trusted `ctx.*` value is treated as scoped and not
 * flagged.
 *
 * Runs only when the codegen feeder supplies raw-run evidence
 * (`context.aiRawRuns`); a runtime caller flags nothing. One finding per
 * arg-derived, unscoped `ctx.ai.run` call.
 */
const aiRawRunEscapeHatch: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.ai.run(model, …)` call selects its model from the handler's `args` with no server-side scoping. `ctx.ai.run` is the raw Workers AI binding passthrough, so an arg-derived model id lets any caller pick an arbitrary model — bypassing the typed `ctx.ai.model(...)` + AI-SDK layer's cap/schema.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ai_raw_run_escape_hatch",
    remediation: `Select the model from a fixed server-side allowlist — never from \`args\`. Prefer the typed \`ctx.ai.model(...)\` + \`generateText\`/\`streamText\` path with an output cap over the raw \`ctx.ai.run\` escape hatch.`,
    run: (context) => {
        if (context.aiRawRuns === undefined) {
            return [];
        }

        return context.aiRawRuns.map((access) =>
            emit(aiRawRunEscapeHatch, {
                cacheKey: `ai_raw_run_escape_hatch:${access.file}:${access.line.toString()}`,
                detail: `\`ctx.ai.run\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) selects its model from \`args\` with no server-side scoping — any caller can pick an arbitrary model, bypassing the typed AI-SDK layer's cap/schema. Select the model from a fixed server-side allowlist instead.`,
                metadata: { exportName: access.exportName, file: access.file, line: access.line },
            }),
        );
    },
    source: "static",
    title: "Possible arbitrary model selection from arg-derived ctx.ai.run",
};

export default aiRawRunEscapeHatch;
