/**
 * Snippets shown in the features video. Each is a real, current Lunora API —
 * `ctx.*` handles codegen wires onto the action context. Kept terse so the
 * window stays readable, but faithful to the package READMEs.
 */

// @lunora/ai — Workers AI on the Vercel AI SDK v6; `ctx.ai` is codegen-wired.
export const AI_CODE = `import { action, v } from "./_generated/server";
import { generateText } from "@lunora/ai";

export const summarize = action
  .input({ text: v.string() })
  .action(async ({ ctx, args }) => {
    const { text } = await generateText({
      model: ctx.ai.model("@cf/meta/llama-3.3-70b"),
      prompt: \`Summarize this: \${args.text}\`,
    });
    return text;
  });`;

// @lunora/payment — Stripe-first, provider-agnostic; `ctx.payments` on actions.
export const PAYMENTS_CODE = `import { action, v } from "./_generated/server";

export const checkout = action
  .input({ priceId: v.string() })
  .action(async ({ ctx, args }) => {
    const { url } = await ctx.payments.createCheckout({
      referenceId: ctx.auth.userId,
      priceId: args.priceId,
      mode: "subscription",
    });
    return { url };
  });`;

// @lunora/workflow — durable steps over Cloudflare Workflows, memoized + retried.
export const WORKFLOWS_CODE = `import { defineWorkflow } from "@lunora/workflow";
import { api } from "./_generated/api";

export const orderPipeline = defineWorkflow({
  handler: async (ctx) => {
    const order = await ctx.step.do("load", () =>
      ctx.run(api.orders.get, { id: ctx.params.orderId }));
    await ctx.step.sleep("cool-off", "1 minute");
    await ctx.step.do("charge", () =>
      ctx.run(api.payments.charge, { orderId: order.id }));
  },
});`;

// @lunora/r2sql — typed R2 SQL: window functions, QUALIFY, DISTINCT, set ops.
export const R2SQL_CODE = `import { action } from "./_generated/server";
import { fn, desc } from "@lunora/r2sql";

export const topPerRegion = action.action(async ({ ctx }) => {
  const { rows } = await ctx.r2sql
    .from("sales.orders")
    .select("region", "customer_id", "total_amount")
    .qualify(fn.rowNumber()
      .over({ partitionBy: "region", orderBy: desc("total_amount") })
      .lte(3))
    .run();
  return rows;
});`;
