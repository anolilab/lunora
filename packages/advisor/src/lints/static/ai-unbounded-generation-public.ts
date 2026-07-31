import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public procedure that runs an AI text/object generation
 * (`generateText` / `streamText` / `generateObject` / `streamObject`) with no
 * `maxOutputTokens` bound in its config.
 *
 * Each generation call bills against the account's Workers AI / provider budget
 * in proportion to the tokens produced. Left unbounded and reachable from a
 * `.public()` procedure, an anonymous caller can request arbitrarily long
 * completions in a loop — a denial-of-wallet vector — and can also tie up worker
 * CPU/time on long streams. The fix is to cap output with `maxOutputTokens` (and
 * ideally rate-limit the entry point).
 *
 * Only a call whose config is a visible object literal is judged; a hoisted or
 * spread config is statically opaque and left un-flagged (fail-open) to avoid a
 * false positive. Runs only when the codegen feeder supplies procedure-protection
 * evidence (`context.procedureProtections`); a runtime caller flags nothing.
 */
const aiUnboundedGenerationPublic: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure runs an AI generation (`generateText`/`streamText`/`generateObject`/`streamObject`) with no `maxOutputTokens` bound. Generation bills per output token, so an anonymous caller can request arbitrarily long completions in a loop — a denial-of-wallet vector that also ties up worker time on long streams.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ai_unbounded_generation_public",
    remediation:
        "Cap the completion with `maxOutputTokens` in the generation config, and rate-limit the public entry point (`.use(rateLimit(...))`). For expensive models, prefer running generation from an internal, authenticated path rather than exposing it directly to anonymous callers.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        // `unboundedAiGeneration === undefined` means the feeder couldn't read the
        // handler body (a cross-file handler) — stays fail-closed, not cleared.
        // Distinct from the call-level opaque-config case, which the feeder
        // always reports as `false` (fail-open by design, see the module doc).
        return context.procedureProtections
            .filter((procedure) => procedure.unboundedAiGeneration !== false && procedure.visibility === "public")
            .map((procedure) =>
                emit(aiUnboundedGenerationPublic, {
                    cacheKey: `ai_unbounded_generation_public:${procedure.file}:${procedure.exportName}`,
                    detail: `\`${procedure.exportName}\` (${procedure.file}) is public and runs an AI generation with no \`maxOutputTokens\` bound — an anonymous caller can drive unbounded, billable completions in a loop. Add a \`maxOutputTokens\` cap and rate-limit the entry point.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
    },
    source: "static",
    title: "Public procedure runs unbounded AI generation (no maxOutputTokens)",
};

export default aiUnboundedGenerationPublic;
