/**
 * Lightweight agent/LLM output scoring for tests — the eval half of the testing
 * toolkit. Score a model/agent output against heuristics (contains / regex /
 * exact-match / keyword coverage) or an LLM-as-judge, and run a whole dataset
 * through `evaluate` to get per-case and aggregate scores. Model-agnostic: the
 * LLM judge takes an injected `judge` function, so this stays dependency-free.
 *
 * ```ts
 * import { agentHarness, evaluate, keywordScorer } from "@lunora/testing";
 *
 * const harness = agentHarness(support, { generate: () => finalTurn("It shipped Tuesday.") });
 * const result = await evaluate(
 *     [{ expected: "shipped", input: "where is my order?" }],
 *     async (input) => (await harness.run({ input, threadKey: input })).text ?? "",
 *     [keywordScorer(["shipped"])],
 * );
 * expect(result.average).toBeGreaterThan(0.5);
 * ```
 */

/** One sample handed to a {@link Scorer}. */
interface ScorerSample {
    /** The reference/gold answer, when the scorer compares against one. */
    expected?: string;
    /** The prompt/input that produced the output (for LLM-judge context). */
    input?: string;
    /** Arbitrary per-sample metadata carried through. */
    metadata?: Record<string, unknown>;
    /** The model/agent output under test. */
    output: string;
}

/** A scorer's verdict: a `[0, 1]` score and an optional human-readable reason. */
interface ScoreResult {
    reason?: string;
    score: number;
}

/** A named scorer — returns a `[0, 1]` score (or a {@link ScoreResult}) for a sample. */
interface Scorer {
    name: string;
    score: (sample: ScorerSample) => Promise<ScoreResult | number> | ScoreResult | number;
}

/** One dataset case: an input and its optional gold answer/metadata. */
interface EvalCase {
    expected?: string;
    input: string;
    metadata?: Record<string, unknown>;
}

/** The per-case eval result: the produced output plus each scorer's verdict and the mean. */
interface EvalItemResult {
    average: number;
    input: string;
    output: string;
    scores: Record<string, ScoreResult>;
}

/** The whole eval run: per-case results plus the mean of their averages. */
interface EvalResult {
    average: number;
    items: EvalItemResult[];
}

/** First signed decimal in a string — used to parse an LLM judge's numeric verdict. */
const FIRST_NUMBER = /-?\d+(?:\.\d+)?/u;

/** Clamp a number into `[0, 1]` (a non-finite value scores 0). */
const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Normalize a scorer's return (a bare number or a {@link ScoreResult}) into a clamped {@link ScoreResult}. */
const normalizeScore = (result: ScoreResult | number): ScoreResult => {
    if (typeof result === "number") {
        return { score: clamp01(result) };
    }

    return { score: clamp01(result.score), ...(result.reason === undefined ? {} : { reason: result.reason }) };
};

/** The mean of a list of numbers (0 for an empty list). */
const mean = (values: ReadonlyArray<number>): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Score 1 if the output contains `needle` (case-insensitive unless `caseSensitive`). */
const containsScorer = (needle: string, options: { caseSensitive?: boolean } = {}): Scorer => {
    return {
        name: `contains:${needle}`,
        score: ({ output }): number => {
            const haystack = options.caseSensitive ? output : output.toLowerCase();
            const target = options.caseSensitive ? needle : needle.toLowerCase();

            return haystack.includes(target) ? 1 : 0;
        },
    };
};

/** Score 1 when `pattern` matches the output. */
const regexScorer = (pattern: RegExp, name = "regex"): Scorer => {
    return { name, score: ({ output }): number => (pattern.test(output) ? 1 : 0) };
};

/** Score 1 when the trimmed output exactly equals the trimmed `expected`. */
const exactMatchScorer = (): Scorer => {
    return {
        name: "exact-match",
        score: ({ expected, output }): number => (output.trim() === expected?.trim() ? 1 : 0),
    };
};

/** Score the fraction of `keywords` (case-insensitive) present in the output. */
const keywordScorer = (keywords: ReadonlyArray<string>): Scorer => {
    return {
        name: "keyword-coverage",
        score: ({ output }): ScoreResult => {
            if (keywords.length === 0) {
                return { reason: "no keywords", score: 1 };
            }

            const lower = output.toLowerCase();
            const hits = keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;

            return { reason: `${String(hits)}/${String(keywords.length)} keywords present`, score: hits / keywords.length };
        },
    };
};

/** Build the LLM-judge prompt for a sample under `criteria`. */
const buildJudgePrompt = (criteria: string, sample: ScorerSample): string =>
    [
        `Rate the ASSISTANT OUTPUT against this criterion: ${criteria}`,
        "Respond with a single number from 0 (fails) to 1 (fully meets), then a dash and a one-line reason.",
        ...(sample.input === undefined ? [] : ["", `Input: ${sample.input}`]),
        ...(sample.expected === undefined ? [] : ["", `Reference answer: ${sample.expected}`]),
        "",
        `Assistant output: ${sample.output}`,
    ].join("\n");

/** Parse an LLM judge's reply (`"0.8 - mostly correct"`) into a clamped {@link ScoreResult}. */
const parseJudgeScore = (raw: string): ScoreResult => {
    const match = FIRST_NUMBER.exec(raw);

    return { reason: raw.trim(), score: match ? clamp01(Number(match[0])) : 0 };
};

/**
 * An LLM-as-judge scorer. `judge` is INJECTED — a `(prompt) => Promise&lt;string>`
 * you wire to your model (e.g. via `ctx.ai` / `generateText`), so this module
 * stays model-agnostic and the judge is mockable in tests. It returns the model's
 * numeric verdict (`[0, 1]`) plus its reason.
 */
const llmScorer = (options: { criteria: string; judge: (prompt: string) => Promise<string>; name?: string }): Scorer => {
    return {
        name: options.name ?? "llm-judge",
        score: async (sample): Promise<ScoreResult> => parseJudgeScore(await options.judge(buildJudgePrompt(options.criteria, sample))),
    };
};

/** Run every scorer over one sample (concurrently) → each verdict keyed by name + their mean. */
const scoreSample = async (sample: ScorerSample, scorers: ReadonlyArray<Scorer>): Promise<{ average: number; scores: Record<string, ScoreResult> }> => {
    const entries = await Promise.all(scorers.map(async (scorer) => [scorer.name, normalizeScore(await scorer.score(sample))] as const));

    return { average: mean(entries.map(([, result]) => result.score)), scores: Object.fromEntries(entries) };
};

/**
 * Run a dataset through `produce` (e.g. an `agentHarness.run` wrapper returning
 * the output text) and score each output with `scorers`. Cases run concurrently;
 * give each its own thread/key inside `produce` if the producer is stateful.
 * Returns per-case results plus the mean of their averages.
 */
const evaluate = async (
    cases: ReadonlyArray<EvalCase>,
    produce: (input: string) => Promise<string> | string,
    scorers: ReadonlyArray<Scorer>,
): Promise<EvalResult> => {
    const items = await Promise.all(
        cases.map(async (testCase): Promise<EvalItemResult> => {
            const output = await produce(testCase.input);
            const sample: ScorerSample = {
                input: testCase.input,
                output,
                ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
                ...(testCase.metadata === undefined ? {} : { metadata: testCase.metadata }),
            };
            const { average, scores } = await scoreSample(sample, scorers);

            return { average, input: testCase.input, output, scores };
        }),
    );

    return { average: mean(items.map((item) => item.average)), items };
};

export type { EvalCase, EvalItemResult, EvalResult, Scorer, ScoreResult, ScorerSample };
export { containsScorer, evaluate, exactMatchScorer, keywordScorer, llmScorer, regexScorer, scoreSample };
