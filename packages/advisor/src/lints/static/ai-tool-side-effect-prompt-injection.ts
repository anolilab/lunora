import type { AdvisorAiToolSideEffect } from "../../ai-tool-side-effects";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `generateText` / `streamText` call whose model input is user-derived
 * **and** whose model-callable `tools` reach a privileged side effect.
 *
 * The AI SDK lets the model call a `tool({ execute })` to take an action. When
 * that tool's `execute` performs a real side effect — a DB write, a function
 * dispatch (`ctx.run`), or an outbound send (fetch / mail / queue) — and the
 * model's prompt / messages carry user-supplied text, an injected instruction in
 * that text can steer the model into firing the side effect. The model becomes a
 * confused deputy: attacker-authored words drive privileged actions. This is the
 * canonical LLM prompt-injection-to-tool-call hazard.
 *
 * Runs only when the codegen feeder supplies generation evidence
 * (`context.aiToolSideEffects`); a runtime caller flags nothing. Fires only when
 * the model input is derived from the handler's `args` — a fully server-authored
 * prompt driving a side-effecting tool is not flagged. Deliberately narrow (an
 * inherently heuristic rule): one finding per matching call.
 */
const aiToolSideEffectPromptInjection: Lint = {
    categories: ["SECURITY"],
    description:
        "A `generateText` / `streamText` call whose prompt/messages carry user-supplied text and whose model-callable `tools` perform a privileged side effect (DB write, `ctx.run` dispatch, or outbound send). An injected instruction in the user text can steer the model into firing that action — the confused-deputy prompt-injection hazard.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ai_tool_side_effect_prompt_injection",
    remediation:
        "Don't let a model with user-derived input directly trigger a privileged action. Have the tool return a proposal the server validates and authorizes before executing, gate the side effect behind an explicit human/step confirmation, or keep side-effecting tools out of any generation whose prompt includes untrusted input.",
    run: (context) => {
        if (context.aiToolSideEffects === undefined) {
            return [];
        }

        return context.aiToolSideEffects
            .filter((row: AdvisorAiToolSideEffect) => row.userInputDerived)
            .map((row) => {
                const location = `\`${row.exportName}\` (${row.file}:${row.line.toString()})`;

                return emit(aiToolSideEffectPromptInjection, {
                    cacheKey: `ai_tool_side_effect_prompt_injection:${row.file}:${row.line.toString()}`,
                    detail: `\`${row.method}\` in ${location} feeds user-derived input to a model whose tools reach \`${row.sideEffect}\`. An injected instruction can steer the model into firing that side effect.`,
                    metadata: {
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        method: row.method,
                        sideEffect: row.sideEffect,
                    },
                });
            });
    },
    source: "static",
    title: "AI tool side effect reachable via prompt injection",
};

export default aiToolSideEffectPromptInjection;
