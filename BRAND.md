# Cirrus Brand Guide

Short and opinionated. The goal: make Cirrus instantly recognizable, **distinct from Cloudflare itself**, and friendly to monochrome contexts (terminal, README, docs site).

## Logo

The Cirrus mark is the **triple streak** — three thin parallel horizontal strokes of decreasing length, top-aligned left, trailing right.

- Reads as: speed, layers (worker / DO / D1), and the edge of a cloud.
- ASCII form: `≡` (used in CLI prompts and where rasterised art is wasted).
- Works at 16px and 1200px without modification.

### Assets

All in [`apps/docs/public/`](./apps/docs/public/):

| File                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `cirrus-mark.svg`     | Mark only — monochrome ink, 120×80 viewBox.              |
| `cirrus-wordmark.svg` | Wordmark only — lowercase, with the accent dot on the i. |
| `cirrus-lockup.svg`   | Standard lockup — mark + wordmark, side by side.         |
| `og.svg`              | Open Graph card, 1200×630, dark mode.                    |
| `favicon.svg`         | 32×32 mark for browser tabs.                             |

## Palette

| Token       | Hex       | Usage                                                               |
| ----------- | --------- | ------------------------------------------------------------------- |
| Ink         | `#0B0F19` | Default foreground. Mark, wordmark, body text on light surfaces.    |
| Paper       | `#FFFFFF` | Default background.                                                 |
| Aerial blue | `#7CC4FF` | Reserved accent. The dot on the `i` of the wordmark. Links on dark. |
| Mute        | `#C9D2E3` | Secondary text on dark backgrounds (taglines, captions).            |

**Hard rule:** _never_ tint the mark Cloudflare orange (`#F38020`) or any orange. Cirrus runs on Cloudflare but is not a Cloudflare product, and orange immediately confuses that.

The aerial-blue accent is a single visual hook — use it on the i-dot, occasional link colour on dark backgrounds, and in code-block string highlights. Do not use it for large fills.

## Typography

- **Wordmark font (aspirational):** [Geist](https://vercel.com/font) or [Inter Tight](https://rsms.me/inter/), `font-weight: 600`, lowercase, tracking `-3`.
- **Fallback stack:** `Inter Tight, Inter, Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`. SVG `<text>` uses this stack — no font files shipped.
- **Body / docs:** Inter or system-ui at weight 400.
- **Code:** JetBrains Mono, Menlo, Consolas, monospace.

The wordmark is always lowercase (`cirrus`, never `Cirrus` or `CIRRUS`). In prose, the product name is capitalised at sentence start as a normal English word.

## Do

- Use the mark on its own when space is tight (favicon, CLI banner, small badges).
- Pair mark and wordmark in the standard lockup for any wider context.
- Honour the aerial-blue accent on exactly one element per surface.
- Keep generous whitespace around the mark — at least the width of one stroke on all sides.

## Don't

- Don't tint the mark Cloudflare orange, or _any_ orange. Use ink (`#0B0F19`) on light, paper (`#FFFFFF`) on dark. That's the whole palette for the mark.
- Don't reorder, equalise, or invert the streaks. They go long → medium → short, top to bottom.
- Don't add a drop shadow, bevel, gradient, or glow.
- Don't lock the wordmark into uppercase or title case.
- Don't replace the accent dot with the full aerial-blue — it stays a small visual hook.
- Don't put the mark inside a circle, badge, or rounded square unless asked specifically (favicon already handles tab contexts).

## Voice

- Direct, technical, not marketing-y. Cirrus is for engineers who already know what a Durable Object is.
- Be honest about the alpha status and the trade-offs (fewer features than Convex; you own the infra).
- Avoid superlatives. Show, don't claim.
