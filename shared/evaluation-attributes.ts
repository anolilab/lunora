/**
 * Shared, bundler-inlined builder for the OpenTelemetry `gen_ai.evaluation.*`
 * attributes an AI **evaluation** verdict (a scorer's `{name, score, label?}`)
 * contributes to a **generation span**.
 *
 * This is the emit-time counterpart of the cloud OTLP decoder, which reads
 * `gen_ai.evaluation.<name>.score` (number) and optional
 * `gen_ai.evaluation.<name>.label` (string) attribute pairs back off a generation
 * span (`EVALUATION_PREFIX = "gen_ai.evaluation."`). The framework emits exactly
 * that pair here so a score rides the same trace as the generation it grades.
 *
 * It lives in `shared/` because more than one layer needs the identical wire
 * format with no runtime dependency edge between them: `@lunora/do` builds it into
 * a live `ctx.trace` span's post-hoc attributes (`SpanHandle.recordEvaluation`),
 * and `@lunora/server` mirrors the handle shape structurally. `@lunora/testing`
 * ships a parallel test-time helper (`recordEvaluation` / `evaluationAttributes`)
 * that targets the same `gen_ai.evaluation.*` contract for span-less eval
 * events/metrics. Keep this file genuinely zero-dependency so inlining stays sound.
 */

/** The primitive an eval contributes to a span: a numeric score or a string label. */
export type EvaluationAttributeValue = number | string;

/** One eval verdict to turn into `gen_ai.evaluation.*` attributes. */
export interface EvaluationInput {
    /**
     * Optional categorical label (e.g. `"pass"` / `"fail"` / a rubric bucket),
     * emitted as the `.label` attribute. Omitted → no label attribute.
     */
    label?: string;

    /**
     * The scorer/evaluation name — becomes the key's name segment. Any character
     * outside `[A-Za-z0-9._-]` is replaced with `_` so a scorer name carrying a
     * colon (e.g. `"contains:shipped"`) still yields a well-formed attribute key.
     */
    name: string;

    /** The numeric score (typically `[0, 1]`), emitted as the `.score` attribute. */
    score: number;
}

/** Characters allowed unescaped in an evaluation-name key segment. */
const SAFE_NAME_CHAR = /[\w.-]/u;

/**
 * Replace every character outside the OTEL-safe set with `_`, so a scorer name
 * carrying a colon/space still yields a well-formed attribute key segment.
 */
export const sanitizeEvaluationName = (name: string): string => {
    let out = "";

    for (const char of name) {
        out += SAFE_NAME_CHAR.test(char) ? char : "_";
    }

    return out;
};

/**
 * Build the `gen_ai.evaluation.<name>.*` attribute bag for one eval verdict — the
 * `.score` (number) always, the `.label` (string) when a label is given. Throws on
 * caller misuse (empty name / non-finite score), since an ill-formed key or a
 * `NaN`/`Infinity` score has no meaningful OTLP encoding and would poison the
 * grade downstream.
 */
export const evaluationAttributes = (input: EvaluationInput): Record<string, EvaluationAttributeValue> => {
    if (typeof input.name !== "string" || input.name.length === 0) {
        throw new Error("recordEvaluation requires a non-empty `name`");
    }

    if (typeof input.score !== "number" || !Number.isFinite(input.score)) {
        throw new Error("recordEvaluation `score` must be a finite number");
    }

    const key = sanitizeEvaluationName(input.name);
    const attributes: Record<string, EvaluationAttributeValue> = { [`gen_ai.evaluation.${key}.score`]: input.score };

    if (input.label !== undefined) {
        attributes[`gen_ai.evaluation.${key}.label`] = input.label;
    }

    return attributes;
};
