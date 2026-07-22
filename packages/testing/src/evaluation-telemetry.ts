/**
 * Bridge an eval score onto telemetry — the emission half of the testing
 * toolkit's `evaluate` scorers. A scorer produces a `[0, 1]` score (see
 * {@link file://./scorer.ts}); `recordEvaluation` turns one such verdict into the
 * `gen_ai.evaluation.*` OpenTelemetry semantic-convention attributes so a score
 * can ride the same trace as the generation it grades.
 *
 * Two shapes, both additive and privacy-safe — only the scorer name, a number,
 * and an optional short label leave, never the graded prompt or completion:
 *
 * Attach to a generation span by passing the post-hoc `SpanHandle` a
 * `ctx.trace(name, (trace, span) =&gt; …)` body receives as `span`, and the score
 * lands on that generation's span. Or omit `span` and use the returned attribute
 * bag as a standalone eval event/metric payload — e.g. `recordEvaluation({ label:
 * "pass", name: "exact-match", score: 1 })` returns
 * `{ "gen_ai.evaluation.exact-match.score": 1, "gen_ai.evaluation.exact-match.label": "pass" }`.
 */
import { LunoraError } from "@lunora/errors";

/** The primitive an eval attaches to a span: a numeric score or a string label. */
type EvaluationAttributeValue = number | string;

/**
 * Structural slice of the post-hoc span handle `ctx.trace` hands its body (see the
 * server `SpanHandle`) — enough to attach an eval's attributes. Declared here
 * rather than imported so `@lunora/testing` takes no dependency on `@lunora/server`
 * or `@lunora/do`; the real handle is assignable to it.
 */
interface EvaluationSpanHandle {
    setAttributes: (fields: Record<string, EvaluationAttributeValue>) => void;
}

/** One eval verdict to emit. */
interface RecordEvaluationInput {
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

    /**
     * Optional generation span to attach the attributes to — the post-hoc
     * `SpanHandle` a `ctx.trace` body receives. Omitted → nothing is attached and
     * the caller uses the returned bag for a standalone event/metric.
     */
    span?: EvaluationSpanHandle;
}

/** Characters allowed unescaped in an evaluation-name key segment. */
const SAFE_NAME_CHAR = /[\w.-]/u;

/** Replace every character outside the OTEL-safe set with `_`. */
const sanitizeName = (name: string): string => {
    let out = "";

    for (const char of name) {
        out += SAFE_NAME_CHAR.test(char) ? char : "_";
    }

    return out;
};

/**
 * Build the `gen_ai.evaluation.NAME.*` attribute bag for one eval verdict — the
 * `.score` (number) always, the `.label` (string) when a label is given. Exported
 * so a caller can emit the score as a standalone event/metric without a span.
 */
const evaluationAttributes = (input: Pick<RecordEvaluationInput, "label" | "name" | "score">): Record<string, EvaluationAttributeValue> => {
    if (typeof input.name !== "string" || input.name.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/testing: recordEvaluation requires a non-empty `name`");
    }

    if (typeof input.score !== "number" || !Number.isFinite(input.score)) {
        throw new LunoraError("BAD_REQUEST", "@lunora/testing: recordEvaluation `score` must be a finite number");
    }

    const key = sanitizeName(input.name);
    const attributes: Record<string, EvaluationAttributeValue> = { [`gen_ai.evaluation.${key}.score`]: input.score };

    if (input.label !== undefined) {
        attributes[`gen_ai.evaluation.${key}.label`] = input.label;
    }

    return attributes;
};

/**
 * Emit one eval verdict as `gen_ai.evaluation.NAME.*` attributes. Attaches them to
 * `input.span` when supplied (the post-hoc generation-span handle), and always
 * returns the attribute bag so a span-less caller can ship it as an eval
 * event/metric. Privacy-safe: only the name, score, and optional label are
 * emitted — never the graded prompt or output.
 */
const recordEvaluation = (input: RecordEvaluationInput): Record<string, EvaluationAttributeValue> => {
    const attributes = evaluationAttributes(input);

    input.span?.setAttributes(attributes);

    return attributes;
};

export type { EvaluationAttributeValue, EvaluationSpanHandle, RecordEvaluationInput };
export { evaluationAttributes, recordEvaluation };
