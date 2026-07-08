/**
 * AI functions — added by `lunora add ai`.
 *
 * This file is YOURS ... you own and edit it.
 */
import { generateText, tool } from "@lunora/ai";
import { z } from "zod";
import { action, v } from "#lunora/_generated/server.js";

/**
 * Summarize text using Workers AI via `ctx.ai`. The `@lunora/ai` package
 * re-exports Vercel AI SDK helpers, so you can build agentic flows
 * directly in your Lunora actions.
 *
 * Requires the `AI` binding in wrangler.jsonc (added by this item).
 */
export const summarize = action.input({ text: v.string().meta({ schema: { maxLength: 100_000 } }) }).action(async ({ args: { text }, ctx }) => {
    const result = await generateText({
        model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        prompt: `Summarize this text in 2-3 sentences:\n\n${text}`,
    });

    return { summary: result.text };
});

/**
 * Analyze sentiment with structured output.
 */
export const analyzeSentiment = action.input({ text: v.string() }).action(async ({ args: { text }, ctx }) => {
    const result = await generateText({
        model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        prompt: `Analyze the sentiment. Respond with one word: positive, negative, or neutral.\n\n${text}`,
    });

    return { sentiment: result.text.trim().toLowerCase() as "positive" | "negative" | "neutral" };
});
