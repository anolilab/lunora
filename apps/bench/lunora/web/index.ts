/**
 * Link previews through Browser Rendering. Wired but inert in local dev: the
 * `BROWSER` binding needs a Cloudflare account, and the call fails only when made.
 */
import { v } from "../_generated/server.js";
import { authAction } from "../lib/crpc.js";

const TITLE = /<title>([^<]*)<\/title>/iu;

export const preview = authAction.input({ url: v.string().url().max(2048) }).action(async ({ args, ctx }) => {
    const html = await ctx.browser.content(args.url);
    const title = TITLE.exec(html)?.[1]?.trim();

    return { title: title ?? args.url };
});
