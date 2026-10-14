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
import { LunoraError } from "@lunora/errors";

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

/**
 * What a `produce` runner may return: the output text alone, or the text plus
 * metadata describing what the run actually did.
 *
 * The metadata form exists for scorers that judge more than the final string —
 * a retrieval scorer needs the ranked ids the run retrieved, which only the run
 * can know. It is merged OVER the case's own metadata before scoring.
 */
interface ProducedOutput {
    /** Merged over the case's `metadata`, then handed to every scorer. */
    metadata?: Record<string, unknown>;
    /** The output text under test. */
    output: string;
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

/**
 * The verdict number at the START of an LLM judge's reply — the instructed
 * format (`"0.8 - reason"`). Anchored so a number elsewhere in prose (e.g. the
 * `0` in "on a 0-1 scale", or an "order #42" reference) is NOT mistaken for the
 * score, and followed by a lookahead for end-of-reply / whitespace / a dash so
 * the number has to BE the verdict: `"1. The answer is wrong"` is a numbered
 * list, not a score of 1, and `"7/10"` is not a 7.
 */
const LEADING_SCORE = /^\s*(-?\d+(?:\.\d+)?)(?=$|[\s\-–—])/u;

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
    // Every string contains the empty string, so an empty needle scores every
    // output a silent 1 — the opposite of a meaningful eval. Reject it at
    // construction, like `keywordScorer`'s empty rubric.
    if (needle.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/testing: containsScorer requires a non-empty needle");
    }

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
    // `.test()` on a `/g` or `/y` regex advances its `lastIndex`, so one scorer
    // reused across a dataset alternates between matching and not — every second
    // sample scores 0 for no reason. Score against a stateless clone instead.
    const stateless = new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, ""));

    return { name, score: ({ output }): number => (stateless.test(output) ? 1 : 0) };
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
    // An empty rubric would score everything a silent 1 — the opposite of a
    // meaningful eval. Reject it at construction (like `codeTool`/`fsTool`).
    if (keywords.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/testing: keywordScorer requires at least one keyword");
    }

    return {
        name: "keyword-coverage",
        score: ({ output }): ScoreResult => {
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

/**
 * Parse an LLM judge's reply (`"0.8 - mostly correct"`) into a {@link ScoreResult}.
 *
 * **Throws** when the reply does not open with a number in `[0, 1]`. A judge that
 * answered `"7/10"`, `"1. The answer is wrong"` or `"no idea"` has not graded the
 * sample, and both alternatives invent a verdict it never gave: clamping used to
 * turn `"7/10"` into a perfect 1, and scoring 0 would report a failure the judge
 * never asserted. No caller catches a scorer error (`scoreSample` and `evaluate`
 * both run scorers under `Promise.all`), so throwing fails the eval — which is
 * the honest outcome when the grader is unreadable.
 */
const parseJudgeScore = (raw: string): ScoreResult => {
    const match = LEADING_SCORE.exec(raw);
    const value = match === null ? Number.NaN : Number(match[1]);

    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/testing: the LLM judge did not answer with a score in [0, 1] — got ${JSON.stringify(raw.trim().slice(0, 200))}`,
        );
    }

    return { reason: raw.trim(), score: value };
};

/**
 * An LLM-as-judge scorer. `judge` is INJECTED — a `(prompt) => Promise<string>`
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
    const results = await Promise.all(
        scorers.map(async (scorer) => {
            return { name: scorer.name, result: normalizeScore(await scorer.score(sample)) };
        }),
    );
    const scores: Record<string, ScoreResult> = {};
    const seen = new Map<string, number>();

    for (const { name, result } of results) {
        // Disambiguate a repeated scorer name (e.g. two `exact-match`s) with a
        // `#n` suffix so every verdict survives in `scores` and stays consistent
        // with `average` — a plain `Object.fromEntries` would drop all but the last.
        const priorCount = seen.get(name) ?? 0;

        seen.set(name, priorCount + 1);
        scores[priorCount === 0 ? name : `${name}#${String(priorCount + 1)}`] = result;
    }

    return { average: mean(results.map(({ result }) => result.score)), scores };
};

/**
 * Run a dataset through `produce` (e.g. an `agentHarness.run` wrapper returning
 * the output text) and score each output with `scorers`. Cases run concurrently;
 * give each its own thread/key inside `produce` if the producer is stateful.
 * Returns per-case results plus the mean of their averages.
 */
const evaluate = async (
    cases: ReadonlyArray<EvalCase>,
    produce: (input: string) => Promise<ProducedOutput | string> | ProducedOutput | string,
    scorers: ReadonlyArray<Scorer>,
): Promise<EvalResult> => {
    const items = await Promise.all(
        cases.map(async (testCase): Promise<EvalItemResult> => {
            const produced = await produce(testCase.input);
            const output = typeof produced === "string" ? produced : produced.output;
            // Run metadata wins over case metadata: the case declares what was
            // *expected* (gold ids), the run reports what actually *happened*
            // (retrieved ids), and only the latter can know the run's outcome.
            const metadata =
                typeof produced === "string" || produced.metadata === undefined ? testCase.metadata : { ...testCase.metadata, ...produced.metadata };
            const sample: ScorerSample = {
                input: testCase.input,
                output,
                ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
                ...(metadata === undefined ? {} : { metadata }),
            };
            const { average, scores } = await scoreSample(sample, scorers);

            return { average, input: testCase.input, output, scores };
        }),
    );

    return { average: mean(items.map((item) => item.average)), items };
};

export type { EvalCase, EvalItemResult, EvalResult, ProducedOutput, Scorer, ScoreResult, ScorerSample };
export { containsScorer, evaluate, exactMatchScorer, keywordScorer, llmScorer, parseJudgeScore, regexScorer, scoreSample };
