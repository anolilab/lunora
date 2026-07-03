/**
 * One `generateText` / `streamText` call whose `tools` reach a privileged side
 * effect — the shared input for the `ai_tool_side_effect_prompt_injection` lint.
 * A model-callable `tool({ execute })` that writes to the database, dispatches
 * another function, or sends outbound (fetch / mail / queue) hands the LLM the
 * trigger for a real-world action; `userInputDerived` records whether the model
 * input (`prompt`/`messages`/`system`) flows from the handler's `args`, the
 * channel a prompt injection rides in on. Produced by the codegen feeder; runtime
 * callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorAiToolSideEffect {
    /** The exported binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the generation call, or `0` when unknown. */
    line: number;
    /** The generation entrypoint invoked. */
    method: "generateText" | "streamText";
    /** The privileged side-effect sink a model-callable tool reaches (`ctx.db.insert`, `ctx.run`, `ctx.fetch`, …). */
    sideEffect: string;
    /** `true` when a model-input option is derived from the handler's `args` (a bare `args.x`, or a name destructured from `args`). */
    userInputDerived: boolean;
}
