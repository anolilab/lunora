/**
 * AI functions — added by `lunora add ai`.
 *
 * This file is YOURS ... you own and edit it.
 *
 * **Workers AI is metered, and Lunora `action`s are public RPC.** An unguarded
 * `summarize({ text })` is an anonymous, unbounded way for anyone who can reach
 * your API to spend your neuron budget — and a free LLM proxy on your account.
 * So both handlers here fail closed: {@link requireUser} rejects unauthenticated
 * callers, a per-caller token bucket caps the burn rate, and the prompt input is
 * length-bounded (a neuron bill scales with tokens, so the input cap *is* a cost
 * control). Widen the bounds deliberately; don't remove them.
 */
import { generateText } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import { RateLimiter, createMemoryStore, rateLimit } from "@lunora/ratelimit";

import { action, v } from "#lunora/_generated/server.js";

/**
 * Per-caller rate limit on the model calls. The default store is in-memory
 * (per-isolate, resets on eviction); run `lunora add ratelimit` for the durable,
 * `ctx.db`-backed store in production, and tune the rate to your budget.
 *
 * The key at each `.use(...)` site below is the authenticated caller, falling
 * back to the server-trusted `ctx.ip` (Cloudflare's `CF-Connecting-IP`,
 * forwarded server-side, never read from a client header) so anonymous traffic
 * can't share — and exhaust — one global `"anon"` bucket.
 */
const limiter = new RateLimiter({
    config: {
        inference: { kind: "token bucket", period: 60_000, rate: 20 },
    },
    store: createMemoryStore(),
});

/** The caller's id, or a clear failure — metered inference is never anonymous here. */
const requireUser = (userId: string | null): string => {
    if (userId === null || userId === undefined) {
        // Coded, not a bare `Error`: an uncoded throw is redacted to a generic
        // 500, so the caller sees a server fault instead of "sign in first".
        throw new LunoraError(
            "UNAUTHORIZED",
            "@lunora/ai registry item: this endpoint requires an authenticated user — Workers AI is metered. Pass `resolveIdentity` to `createWorker` (see the auth registry item) before exposing it.",
        );
    }

    return userId;
};

/**
 * Summarize text using Workers AI via `ctx.ai`. The `@lunora/ai` package
 * re-exports Vercel AI SDK helpers, so you can build agentic flows
 * directly in your Lunora actions.
 *
 * Requires the `AI` binding in wrangler.jsonc (added by this item).
 */
export const summarize = action
    .input({ text: v.string().max(20_000) })
    .use(rateLimit(limiter, "inference", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { text }, ctx }) => {
        requireUser(ctx.auth.userId);

        const result = await generateText({
            model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
            prompt: `Summarize this text in 2-3 sentences:\n\n${text}`,
        });

        return { summary: result.text };
    });

/**
 * Analyze sentiment with structured output.
 */
export const analyzeSentiment = action
    .input({ text: v.string().max(20_000) })
    .use(rateLimit(limiter, "inference", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { text }, ctx }) => {
        requireUser(ctx.auth.userId);

        const result = await generateText({
            model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
            prompt: `Analyze the sentiment. Respond with one word: positive, negative, or neutral.\n\n${text}`,
        });

        return { sentiment: result.text.trim().toLowerCase() as "positive" | "negative" | "neutral" };
    });
