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

/** What one model costs. Token models price per **one million** tokens; image models price per generated image. */
interface ModelPrice {
    /** Price per million input tokens read from the provider's cache. Omit to bill cache reads at `input`. */
    cacheRead?: number;
    /** Price per million input tokens written to the provider's cache. Omit to bill cache writes at `input`. */
    cacheWrite?: number;
    /** Price per million input (prompt) tokens. Token-billed models only. */
    input?: number;
    /** Price per million output (completion) tokens. Omit for an embedding model. */
    output?: number;
    /** Price per generated image, in USD. Image models only. */
    perImage?: number;
}

/** Token counts to price. Any may be absent. The cache counts are subsets of `inputTokens`. */
interface ModelUsage {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
}

/** Tokens per unit of the price table. */
const TOKENS_PER_UNIT = 1_000_000;

/** A finite count clamped at 0; an absent or non-numeric count is 0. */
const nonNegative = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0);

/** A trailing `-YYYY-MM-DD` release stamp, e.g. `gpt-5-2025-08-07`. */
const DATED_MODEL_ID = /^(.*)-\d{4}-\d{2}-\d{2}$/u;

/**
 * An indicative price table, keyed by model id.
 *
 * Deliberately small: a table that tries to cover every model is a table that
 * is wrong about most of them. It holds the models Lunora's own defaults and
 * documented examples reference — text generation and embeddings, on Workers AI
 * and OpenAI — and everything else returns `undefined` rather than a guess.
 *
 * Generation models carry an `output` price; embedding models do not (they have
 * no completion). Image models carry a `perImage` price instead — the unit an
 * image call is billed in, not tokens. A generation model missing from here is
 * why a chat span would carry no cost at all off an AI Gateway, so the ids the
 * docs teach are the ones that have to be in the table.
 */
const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
    // Workers AI embedding models. Priced per model, not per family — the four
    // BGE variants span an order of magnitude, and `bge-base-en-v1.5` (Lunora's
    // documented default) is over three times `bge-small-en-v1.5`.
    "@cf/baai/bge-base-en-v1.5": { input: 0.067 },
    "@cf/baai/bge-large-en-v1.5": { input: 0.204 },
    "@cf/baai/bge-m3": { input: 0.012 },
    "@cf/baai/bge-small-en-v1.5": { input: 0.02 },

    // Workers AI text-generation models — the ids every `defineAgent` /
    // `ctx.ai.model()` example in the docs uses. Input and output are priced
    // separately and differ by ~8x on the 70b, so an input-only estimate would
    // understate a generation badly.
    "@cf/meta/llama-3.1-8b-instruct": { input: 0.28, output: 0.83 },
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.29, output: 2.25 },

    // Image models, priced per generated image (`perImage`, USD). Indicative
    // per-image figures for the default 1024×1024 single-image call: Workers AI
    // bills flux by 512×512 tile and step, so that entry is those rates for the
    // default four-tile/four-step shape; the OpenAI ids are their published
    // per-image list price for a 1024×1024 render.
    "@cf/black-forest-labs/flux-1-schnell": { perImage: 0.000_633_6 },
    "dall-e-3": { perImage: 0.04 },
    "gpt-image-1": { perImage: 0.04 },

    // OpenAI embedding models.
    "text-embedding-3-large": { input: 0.13 },
    "text-embedding-3-small": { input: 0.02 },

    // OpenAI chat models — the non-Cloudflare half of the same examples.
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-5": { input: 1.25, output: 10 },
};

/**
 * Normalise a model id for lookup: strip a provider prefix (`openai/gpt-5`) and
 * a trailing date stamp (`gpt-5-2025-08-07`), which is how the same model
 * reaches us under several ids.
 */
const normalizeModelId = (modelId: string): string[] => {
    const trimmed = modelId.trim();
    // A provider-prefixed Workers AI id (`workers-ai/@cf/meta/...`, the AI
    // Gateway's unified form) keeps everything from its `@`, since the Workers AI
    // id is itself slash-delimited.
    const workersAi = trimmed.indexOf("/@");
    const unprefixed = workersAi === -1 ? trimmed : trimmed.slice(workersAi + 1);
    const slash = unprefixed.lastIndexOf("/");

    // A Workers AI id is itself slash-delimited (`@cf/baai/...`), so only strip
    // a prefix when the id does not start with `@` — otherwise `@cf/baai/bge-m3`
    // would be reduced to `bge-m3` and miss its own entry.
    const base = slash !== -1 && !unprefixed.startsWith("@") ? [unprefixed, unprefixed.slice(slash + 1)] : [unprefixed];

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

    // An image-only price has no token rate: zero tokens would price to a false $0.
    if (price?.input === undefined && price?.output === undefined) {
        return undefined;
    }

    // Clamped at 0, not merely checked for finiteness: a provider that reports a
    // negative token count would otherwise stamp a NEGATIVE `gen_ai.usage.cost`
    // on the span, which subtracts from every total that span rolls into.
    const inputTokens = nonNegative(usage.inputTokens);
    const outputTokens = nonNegative(usage.outputTokens);

    if (inputTokens <= 0 && outputTokens <= 0) {
        return undefined;
    }

    // Cache tokens are already inside `inputTokens`, so they are priced as the
    // difference from the input rate rather than split out of the total. With no
    // cache rate listed the difference is zero and the cost is the plain input cost.
    const cacheReadTokens = Math.min(nonNegative(usage.cacheReadTokens), inputTokens);
    const cacheWriteTokens = Math.min(nonNegative(usage.cacheWriteTokens), inputTokens - cacheReadTokens);
    const inputRate = price.input ?? 0;
    const cost =
        (inputTokens * inputRate +
            cacheReadTokens * ((price.cacheRead ?? inputRate) - inputRate) +
            cacheWriteTokens * ((price.cacheWrite ?? inputRate) - inputRate) +
            outputTokens * (price.output ?? 0)) /
        TOKENS_PER_UNIT;

    return Number.isFinite(cost) ? cost : undefined;
};

/**
 * Estimate the cost of generating `count` images in USD, or `undefined` when the
 * model is not priced or carries no image price.
 *
 * Like {@link estimateModelCost}, returns `undefined` rather than `0` for an
 * unpriced model, so a missing price shows up as absent instead of folding a
 * false zero into a total.
 * @experimental
 */
const estimateImageCost = (modelId: string | undefined, count = 1, prices?: Readonly<Record<string, ModelPrice>>): number | undefined => {
    if (modelId === undefined || modelId.length === 0) {
        return undefined;
    }

    const price = lookupModelPrice(modelId, prices);

    if (price?.perImage === undefined) {
        return undefined;
    }

    const images = Number.isFinite(count) ? Math.max(0, count) : 0;

    if (images <= 0) {
        return undefined;
    }

    const cost = images * price.perImage;

    return Number.isFinite(cost) ? cost : undefined;
};

export type { ModelPrice, ModelUsage };
export { DEFAULT_MODEL_PRICES, estimateImageCost, estimateModelCost, lookupModelPrice };
