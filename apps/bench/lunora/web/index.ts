/**
 * Link previews through Browser Rendering. Wired but inert in local dev: the
 * `BROWSER` binding needs a Cloudflare account, and the call fails only when made.
 */
import { LunoraError } from "@lunora/errors";

import { v } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { spendRootBudget } from "../ratelimit/root";

const TITLE = /<title(?:\s[^>]*)?>([^<]*)<\/title>/iu;

export const preview = authAction.input({ url: v.string().url().max(2048) }).action(async ({ args, ctx }) => {
    // Each preview is a billed browser session, so the caller draws from the shared root budget first.
    const budget = await spendRootBudget("preview", ctx.auth.userId ?? ctx.ip ?? "anon");

    if (!budget.ok) {
        throw new LunoraError("RATE_LIMITED", `link previews are limited per caller; retry in ${String(budget.retryAfter ?? 0)} ms`);
    }

    const html = await ctx.browser.content(args.url);
    const title = TITLE.exec(html)?.[1]?.trim();

    return { title: title ?? args.url };
});
