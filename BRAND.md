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
| Ink          | `#0B0F19` | Default foreground. Mark, wordmark, body text on light surfaces.       |
| Paper        | `#FFFFFF` | Default background.                                                    |
| Brand yellow | `#FCC419` | The accent. The dot on the `i`, primary buttons, links, focus rings.   |
| Mute         | `#A0A0A0` | Secondary text on dark backgrounds (taglines, captions).               |

**Hard rule:** _never_ tint the mark Cloudflare orange (`#F38020`) or any orange. Cirrus runs on Cloudflare but is not a Cloudflare product, and orange immediately confuses that. The brand accent is a clear lemon-gold yellow (`#FCC419`) — keep it on the yellow side of the line, never let it drift toward amber/orange.

The brand-yellow accent is a single visual hook — use it on the i-dot, primary buttons, link colour, focus rings, and code-block string highlights. One hook per surface; don't flood large areas with it.

## Design system (UI)

The four-colour brand palette above is the _identity_. For product surfaces — the
docs/marketing site and the dashboard — it expands into a tokenised UI scale that
keeps the same anchors (neutral-dark base, brand-yellow accent, no orange) but
adds the surfaces, borders and semantic colours an interface needs. The product
surfaces follow **Supabase Studio's neutral-gray scale** — swap their signature
green for the Cirrus yellow, keep everything else.

The canonical tokens live in **[`brand/tokens.css`](./brand/tokens.css)** as CSS
custom properties (`--cirrus-*`). The **dark theme is primary** — a near-black
night sky above the cirrus layer — with a `:root[data-theme="light"]` paper
variant. A self-contained reference page that exercises the whole language
(mark, palette, type, components, a dashboard mock) is at
**[`brand/cirrus-brand.html`](./brand/cirrus-brand.html)** — open it in a browser
when designing the cirrus page.

| Role               | Dark (primary) | Light (paper) | Notes                                     |
| ------------------ | -------------- | ------------- | ----------------------------------------- |
| App background     | `#121212`      | `#FBFBFB`     | Content area.                             |
| Surface (chrome)   | `#1C1C1C`      | `#FFFFFF`     | Top bar, sidebar, cards.                  |
| Border             | `#2E2E2E`      | `#E6E6E6`     | Strong variant `#3E3E3E` / `#D4D4D4`.     |
| Foreground         | `#EDEDED`      | `#171717`     | Muted `#A0A0A0` / `#5D5D5D`.              |
| Accent (fill)      | `#FCC419`      | `#FCC419`     | Brand yellow — near-black text on fill.   |
| Accent (text/link) | `#FFD43B`      | `#8A6100`     | Brighter on dark; dark gold on paper.     |
| Success            | `#3ECF8E`      | `#1A9D6A`     | Live/connected — the repurposed green.    |
| Danger             | `#F25C5C`      | `#D92D20`     | Destructive confirms.                     |

**Type in product:** Inter Tight for display/body (tight tracking, weight 600 on
headings), **JetBrains Mono** for eyebrows, code, IDs and every number. The
mono-eyebrow + tight-display pairing is the product's signature — it reads
engineered, not marketed.

The dashboard (`@cirrus/dashboard`) mirrors these values under a `--c-*` namespace
in its own scoped stylesheet (it can't ship globals into a host page); the layout
is a top bar + grouped left sidebar + content, in the spirit of a studio console.

## Typography

- **Wordmark font (aspirational):** [Geist](https://vercel.com/font) or [Inter Tight](https://rsms.me/inter/), `font-weight: 600`, lowercase, tracking `-3`.
- **Fallback stack:** `Inter Tight, Inter, Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`. SVG `<text>` uses this stack — no font files shipped.
- **Body / docs:** Inter or system-ui at weight 400.
- **Code:** JetBrains Mono, Menlo, Consolas, monospace.

The wordmark is always lowercase (`cirrus`, never `Cirrus` or `CIRRUS`). In prose, the product name is capitalised at sentence start as a normal English word.

## Do

- Use the mark on its own when space is tight (favicon, CLI banner, small badges).
- Pair mark and wordmark in the standard lockup for any wider context.
- Honour the brand-yellow accent on exactly one element per surface.
- Keep generous whitespace around the mark — at least the width of one stroke on all sides.

## Don't

- Don't tint the mark Cloudflare orange, or _any_ orange. Use ink (`#0B0F19`) on light, paper (`#FFFFFF`) on dark. That's the whole palette for the mark.
- Don't reorder, equalise, or invert the streaks. They go long → medium → short, top to bottom.
- Don't add a drop shadow, bevel, gradient, or glow.
- Don't lock the wordmark into uppercase or title case.
- Don't replace the accent dot with a large yellow fill — it stays a small visual hook.
- Don't put the mark inside a circle, badge, or rounded square unless asked specifically (favicon already handles tab contexts).

## Voice

- Direct, technical, not marketing-y. Cirrus is for engineers who already know what a Durable Object is.
- Be honest about the alpha status and the trade-offs (fewer features than Convex; you own the infra).
- Avoid superlatives. Show, don't claim.
