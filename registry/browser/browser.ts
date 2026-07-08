/**
 * Browser rendering — added by `lunora add browser`.
 *
 * Headless browser screenshots, PDF capture, and HTML scraping via
 * ctx.browser in actions. Powered by Cloudflare Browser Rendering
 * (@cloudflare/playwright).
 *
 * Requires the BROWSER binding in wrangler.jsonc (added by this item)
 * and a Browser Rendering provisioned in your Cloudflare dashboard.
 *
 * Usage:
 *   const png = await ctx.browser.screenshot("https://example.com");
 *   const pdf = await ctx.browser.pdf("https://example.com/report");
 *   const text = await ctx.browser.scrape("https://example.com", (page) => page.innerText("body"));
 */
import { action, v } from "#lunora/_generated/server.js";

/**
 * Capture a screenshot of a URL. The browser is launched in a remote
 * Cloudflare Browser Rendering instance — bytes never touch your Worker.
 */
export const screenshot = action
    .input({
        url: v.string().meta({ schema: { maxLength: 2048 } }),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
    })
    .action(async ({ args: { url, height, width }, ctx }) => {
        const png = await ctx.browser.screenshot(url, {
            viewport: width !== undefined && height !== undefined ? { width, height } : undefined,
        });

        return { png: [...png] };
    });

/**
 * Capture a PDF of a URL.
 */
export const pdf = action.input({ url: v.string().meta({ schema: { maxLength: 2048 } }) }).action(async ({ args: { url }, ctx }) => {
    const pdfBytes = await ctx.browser.pdf(url, { format: "A4" });

    return { pdf: [...pdfBytes] };
});
