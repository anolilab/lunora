/**
 * Model cost estimation without an AI Gateway.
 *
 * Per-request dollar cost previously reached a span only when a Cloudflare AI
 * Gateway put it in `providerMetadata`. Run the same model through
 * `@ai-sdk/openai` directly, or on any non-Cloudflare host, and spend
 * visibility silently disappeared — inside a telemetry stack that is otherwise
 * host-neutral by design.
 *
 * This derives cost from token usage and a price table instead, so the number
 * is there either way.
 *
 * **An estimate is never presented as a measurement.** A provider-reported cost
 * always wins, and a span carrying an estimate is tagged
 * `lunora.usage.cost.source: "estimated"` so a dashboard can tell the two
 * apart. Getting that wrong turns a rounding error into a billing dispute.
 *
 * **Prices go stale.** The shipped table is indicative, not authoritative — it
 * is a hand-maintained snapshot, and providers change prices without warning.
 * Pass your own `prices` for anything you are actually invoicing against.
 * @experimental
 */

/** What one model costs, in USD per **one million** tokens. */
interface ModelPrice {
    /** Price per million input (prompt) tokens. */
    input: number;
    /** Price per million output (completion) tokens. Omit for an embedding model. */
    output?: number;
}

/** Token counts to price. Either may be absent. */
interface ModelUsage {
    inputTokens?: number;
    outputTokens?: number;
}

/** Tokens per unit of the price table. */
const TOKENS_PER_UNIT = 1_000_000;

/** A trailing `-YYYY-MM-DD` release stamp, e.g. `gpt-5-2025-08-07`. */
const DATED_MODEL_ID = /^(.*)-\d{4}-\d{2}-\d{2}$/u;

/**
 * An indicative price table, keyed by model id.
 *
 * Deliberately small: a table that tries to cover every model is a table that
 * is wrong about most of them. It holds the Workers AI models Lunora's own
 * defaults reference plus the common OpenAI embedding models, and everything
 * else returns `undefined` rather than a guess.
 */
const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
    // Workers AI embedding models. Priced per model, not per family — the four
    // BGE variants span an order of magnitude, and `bge-base-en-v1.5` (Lunora's
    // documented default) is over three times `bge-small-en-v1.5`.
    "@cf/baai/bge-base-en-v1.5": { input: 0.067 },
    "@cf/baai/bge-large-en-v1.5": { input: 0.204 },
    "@cf/baai/bge-m3": { input: 0.012 },
    "@cf/baai/bge-small-en-v1.5": { input: 0.02 },

    // OpenAI embedding models.
    "text-embedding-3-large": { input: 0.13 },
    "text-embedding-3-small": { input: 0.02 },
};

/**
 * Normalise a model id for lookup: strip a provider prefix (`openai/gpt-5`) and
 * a trailing date stamp (`gpt-5-2025-08-07`), which is how the same model
 * reaches us under several ids.
 */
const normalizeModelId = (modelId: string): string[] => {
    const trimmed = modelId.trim();
    const slash = trimmed.lastIndexOf("/");

    // A Workers AI id is itself slash-delimited (`@cf/baai/...`), so only strip
    // a prefix when the id does not start with `@` — otherwise `@cf/baai/bge-m3`
    // would be reduced to `bge-m3` and miss its own entry.
    const base = slash !== -1 && !trimmed.startsWith("@") ? [trimmed, trimmed.slice(slash + 1)] : [trimmed];

    return base.flatMap((candidate) => {
        const undated = DATED_MODEL_ID.exec(candidate)?.[1];

        return undated === undefined ? [candidate] : [candidate, undated];
    });
};

/**
 * Look up a model's price, or `undefined` when the table does not cover it.
 * @experimental
 */
const lookupModelPrice = (modelId: string, prices: Readonly<Record<string, ModelPrice>> = DEFAULT_MODEL_PRICES): ModelPrice | undefined => {
    for (const candidate of normalizeModelId(modelId)) {
        if (Object.hasOwn(prices, candidate)) {
            return prices[candidate];
        }
    }

    return undefined;
};

/**
 * Estimate a call's cost in USD from its token usage, or `undefined` when the
 * model is not priced or no usable token count was supplied.
 *
 * Returns `undefined` rather than `0` for an unpriced model: zero is a
 * defensible cost that would quietly sum into a total, while an absent value
 * shows up as absent.
 * @experimental
 */
const estimateModelCost = (modelId: string | undefined, usage: ModelUsage, prices?: Readonly<Record<string, ModelPrice>>): number | undefined => {
    if (modelId === undefined || modelId.length === 0) {
        return undefined;
    }

    const price = lookupModelPrice(modelId, prices);

    if (price === undefined) {
        return undefined;
    }

    // Clamped at 0, not merely checked for finiteness: a provider that reports a
    // negative token count would otherwise stamp a NEGATIVE `gen_ai.usage.cost`
    // on the span, which subtracts from every total that span rolls into.
    const inputTokens = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens as number) : 0;
    const outputTokens = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens as number) : 0;

    if (inputTokens <= 0 && outputTokens <= 0) {
        return undefined;
    }

    const cost = (inputTokens * price.input + outputTokens * (price.output ?? 0)) / TOKENS_PER_UNIT;

    return Number.isFinite(cost) ? cost : undefined;
};

export type { ModelPrice, ModelUsage };
export { DEFAULT_MODEL_PRICES, estimateModelCost, lookupModelPrice };
