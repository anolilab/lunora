/**
 * Feature flags — added by `lunora add flags`.
 *
 * Declares a `flagship`-backed feature flag provider. Codegen discovers this
 * export and wires `ctx.flags` onto every query, mutation, and action context.
 *
 * Usage:
 *   const isEnabled = await ctx.flags.boolean("dark_mode", false);
 *   const pageSize  = await ctx.flags.number("page_size", { defaultValue: 25 });
 *
 * Requires the `FLAGS` binding in wrangler.jsonc (the @cloudflare/
 * flagship-binding was added as a dep; add the binding to your wrangler
 * config for production, or use `memoryProvider` / `envProvider` below).
 */
import { defineFlags } from "@lunora/flags";
import { memoryProvider } from "@lunora/flags/providers/memory";

export default defineFlags({
    /** Static in-memory provider, perfect for local dev. Swap to
     * `flagshipProvider({ binding: "FLAGS" })` once you provision a
     * Cloudflare Flagship account for production. */
    provider: memoryProvider({
        dark_mode: { defaultValue: false, type: "boolean" },
        page_size: { defaultValue: 25, type: "number" },
        beta_features: { defaultValue: false, type: "boolean" },
    }),

    /** Derive the OpenFeature targeting key from the authenticated user. */
    identify: (auth) => auth.userId ?? undefined,
});
