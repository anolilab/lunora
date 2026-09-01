# browser

Cloudflare Browser Rendering for Lunora. Headless browser screenshots, PDF capture, and HTML scraping via `ctx.browser` in actions — powered by `@cloudflare/playwright` over the `BROWSER` binding.

Built on [`@lunora/browser`](../../packages/browser) — the thin `ctx.browser` facade over Cloudflare's Browser Rendering API.

## Install

```bash
lunora registry add browser
```

This:

1. Adds `@lunora/browser`, `@lunora/server`, `@lunora/ratelimit`, and `@cloudflare/playwright` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/browser/index.ts` (the `screenshot` and `pdf` actions, with their auth guard, host allowlist, and rate limit) into your project — this is **yours** to edit.
3. Adds a `browser` binding entry to `wrangler.jsonc` for the **`BROWSER`** binding.

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` as `browser/screenshot` and `browser/pdf` — i.e. `api.browser.screenshot` and `api.browser.pdf`.

## Prerequisites

1. **Browser Rendering** must be provisioned in your Cloudflare dashboard. Go to **Workers & Pages → Browser Rendering** and add a new endpoint. Note your binding name (default `BROWSER`).
2. The **`BROWSER` binding** is added to `wrangler.jsonc` by this item. If you use a different binding name, update both `wrangler.jsonc` and the codegen config.

## How it works

- **`ctx.browser`** exposes three methods, each returning a `Promise`:
    - **`screenshot(url, opts?)`** — returns a `Uint8Array` of the PNG screenshot.
    - **`pdf(url, opts?)`** — returns a `Uint8Array` of the PDF.
    - **`scrape(url, fn)`** — runs an arbitrary `page.evaluate`-like function in the browser and returns its result.
- The browser is launched in a remote Cloudflare Browser Rendering instance. Bytes (screenshot/pdf) never touch your Worker — only the final output is returned.

### Screenshot

```ts
const png = await ctx.browser.screenshot("https://example.com", {
    viewport: { width: 1280, height: 720 },
});
// png is a Uint8Array — serve it as an image, upload to R2, etc.
```

### PDF

```ts
const pdfBytes = await ctx.browser.pdf("https://example.com/report", {
    format: "A4",
});
```

### Scraping

```ts
const text = await ctx.browser.scrape("https://example.com", async (page) => page.innerText("body"));
```

The scraper function receives a Playwright `Page` — you can use any Playwright API (`page.$eval`, `page.content`, `page.locator`, etc.).

## Security: the render target is an SSRF sink

Lunora `action`s are public RPC. A `screenshot({ url })` that renders whatever the caller names lets any anonymous client point **your** Browser Rendering instance at any URL and read the rendered bytes back — including your own private routes and internal hostnames reachable from Cloudflare's fleet. Browser Rendering is metered, so the same endpoint is also an unauthenticated way to run your bill up.

The scaffolded handlers therefore fail closed on three axes:

1. **Auth** — `requireUser` rejects unauthenticated callers.
2. **Target** — `assertAllowedTarget` accepts only `https:` URLs whose host is in `ALLOWED_RENDER_HOSTS`. That set ships **empty**, so nothing renders until you list the hosts you actually render.
3. **Rate** — a per-caller token bucket keyed `ctx.auth.userId ?? ctx.ip ?? "anon"`, so one account (or one anonymous IP) can't drain the quota.

### Pin the allowlist on the browser too

The check in the copied file is the fail-closed default. The hard guarantee is `allowedHosts` on `createBrowser` — it is enforced on every navigation **and** every subresource request, and it is what satisfies the `browser_user_url_without_allowlist` advisor lint:

```ts
import { launch } from "@cloudflare/playwright";
import { createBrowser } from "@lunora/browser";

createShardDO({
    browser: (env) => createBrowser({ allowedHosts: ["example.com"], binding: env.BROWSER, launch }),
});
```

Never set `allowPrivateTargets: true` — that disables the private/internal-address guard that stops a render reaching cloud metadata, internal services, or loopback (`browser_allow_private_targets`, an ERROR-level advisor lint).

## What you own

Everything under `lunora/browser/` is copied into your repo — change the viewport, add more actions (scrape, print to PDF with custom margins, take full-page screenshots), or wire in different browser automation flows however you like. `@lunora/browser` provides the `ctx.browser` facade; this component is the idiomatic Lunora glue that turns it into `api.browser.*`.
