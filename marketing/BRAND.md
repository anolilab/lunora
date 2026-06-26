# Lunora Brand Guide

Short and opinionated. The goal: make Lunora instantly recognizable, **distinct
from Cloudflare itself**, and legible everywhere — terminal, README, docs, video.

This file owns the **mark, wordmark, voice, and the canonical copy**. The full
visual spec — color, surface, type scale, motion — lives in
[`design-tokens/DESIGN.md`](./design-tokens/DESIGN.md), with the consumable values
in [`design-tokens/tokens.css`](./design-tokens/tokens.css) (Tailwind v4) and
[`design-tokens/tokens.ts`](./design-tokens/tokens.ts) (JS/TS). When this guide and
the tokens disagree, **the tokens win** — fix this file.

## Concept

**Lunora = Luna + Aurora.** A real-time backend that runs globally, at the edge,
while you sleep. The identity is **nocturnal and luminous**: a deep night sky,
cool moonlight neutrals, and a single **aurora ribbon** used sparingly for energy.
The structure is **refined-brutalist** — sharp rectangles, hairline rules, mono
labels — to match the product surface. Sharp edges, soft light.

Three words: **nocturnal · luminous · precise.**

## Logo

The Lunora mark is the **moon** — a single crescent/swirl glyph (the 🌙 in the
name). It reads as luna, night, and the curve of an orbit at the edge.

- **Canonical geometry:** [`../.github/assets/lunora.svg`](../.github/assets/lunora.svg)
  (`viewBox="0 0 543 446"`, one path). Every other copy derives from this — do not
  redraw it.
- **ASCII / text form:** `🌙` (CLI banners, small badges, places where rasterised
  art is wasted).
- Works at 16px and 1200px without modification.

### Two fills

| Fill                                                                        | When                                                                                                                                              | Reference                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Ink** (`currentColor`, near-black `#040404` on light / moonlight on dark) | Default. Monochrome contexts: README, CLI, docs nav, the marketing video (white-on-black). Inherits `currentColor`, so it flips with the surface. | `.github/assets/lunora.svg`, `apps/docs/src/assets/lunora_logo.svg` |
| **Aurora gradient**                                                         | Expressive moments only: the favicon, OG cards, hero accents.                                                                                     | `apps/docs/public/favicon.svg`                                      |

The favicon ships an **animated aurora gradient** (a 20s loop through
`#E53935 → #8E44AD → #0073E6`). The design system's canonical static ribbon is the
slightly cooler **aurora ramp** — Aurora Cyan → Violet → Rose (see Palette). Violet
is the through-line of both; if you unify them, unify toward the token ramp.

### Assets

| File                                                                                                              | Purpose                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`../.github/assets/lunora.svg`](../.github/assets/lunora.svg)                                                    | Canonical mark — ink, `viewBox 543×446`. Source of truth for geometry.                                 |
| `apps/docs/src/assets/lunora_logo.svg`                                                                            | Docs mark — same path, `currentColor` fill (used by the navbar/footer React components).               |
| `apps/docs/public/favicon.svg`                                                                                    | Favicon — moon filled with the animated aurora gradient.                                               |
| `apps/docs/public/og-default.jpg`                                                                                 | Default Open Graph card. Per-page OG is generated at `apps/docs/src/routes/api/og.ts`.                 |
| `videos/public/brand/lunora.svg` (in the [`lunora-marketing`](https://github.com/anolilab/lunora-marketing) repo) | Mark mirrored for the Remotion video project (+ `cloudflare.svg` for the "Built for Cloudflare" beat). |

There is **no separate wordmark/lockup SVG today** — the wordmark is set in live
text next to the mark (see Typography). Generate a static lockup only if a context
needs it.

## Wordmark

The wordmark is the product name set in **Geist Sans**, weight 600, lowercase,
tight tracking, beside the mark. Always lowercase (`lunora`, never `Lunora` or
`LUNORA`). In prose, the product name is capitalised at sentence start as a normal
English word ("Lunora is …").

## Palette

Full table + tokens in [`design-tokens/DESIGN.md`](./design-tokens/DESIGN.md). The
short version:

- **Night & moonlight (neutrals).** Cool blue-violet cast (hue ~240), never neutral
  gray. Eclipse base `#0e0e11` (`--dark-coal`), midnight `hsl(240 14% 6%)`, raised
  surfaces `hsl(240 14% 9%)`, moonlight text `hsl(228 30% 96%)`. The **dark theme is
  primary**; a light "paper" variant exists (`:root` in `tokens.css`).
- **Aurora (accents).** One luminous ramp — **Cyan** `hsl(186 84% 56%)` → **Violet**
  `hsl(256 72% 68%)` → **Rose** `hsl(330 80% 64%)` — used as the **aurora ribbon**
  gradient on _the_ focal moment (hero headline accent, active underline, focus
  ring), or individually for state (cyan = info/active, violet = primary, rose =
  emphasis). **Aurora is light, not paint:** keep it under ~10% of any view.
- **Primary glow = Aurora Violet** — the closest thing to a single brand color, and
  the one deliberate color beat behind the mark on logo reveals.
- **Amber is data-status only** (warnings), never a brand accent.

**Hard rule:** never recolor the mark — or anything — **Cloudflare orange**
(`#F38020`) or imply Lunora is a Cloudflare product. Lunora runs _on_ Cloudflare; it
is not Cloudflare. The brand's warm note is the aurora rose/red inside the gradient,
never CF orange.

## Typography

- **Wordmark & display:** Geist Sans, weight 600, lowercase, tight tracking.
- **Body / docs:** Geist Sans (`--font-sans`).
- **Code, labels, file tabs, numbers, the install command:** Geist Mono
  (`--font-mono`). Mono is a recurring motif — it signals "this is real code."

(Tokens define `--font-sans` / `--font-mono` / `--font-display` as Geist; the fonts
are loaded by each surface.)

## Canonical copy

The one-liner, repeated until it's boring: **"Convex DX on your own Cloudflare
account."** From the marketing video (`videos/src/shared/theme.ts`):

- **Tagline:** _Real-time. End-to-end typed. On your own Cloudflare._
- **Outro:** _Real-time, typed, and entirely yours._
- **Eyebrow:** _Built for Cloudflare._
- **First step / CTA:** `pnpm dlx lunorash@alpha init`
- **Kinetic beats:** REAL-TIME · TYPE-SAFE · EDGE-NATIVE · NO LOCK-IN · YOUR CLOUDFLARE.

## Lunora Cloud (planned)

The open-source framework is the engine; **Lunora Cloud** is the planned managed
product on top of it (the business — see the marketing plan). Brand stance:

- **One brand, a descriptor — not a sub-brand.** It's **"Lunora Cloud,"** under the
  same moon mark and the same Luna+Aurora system. No second logo, no separate
  identity. Splitting a zero-to-small audience across two brands this early is a
  cost with no upside.
- **The two mark-fills carry the free/paid distinction.** This is the job the
  gradient fill earns:
    - **Ink mark** → the open-source framework (README, CLI, docs).
    - **Aurora-gradient mark** → Lunora Cloud — the hosted, "luminous" tier. The
      aurora is Cloud's signature; the OSS stays monochrome.
- **Brand promise: no lock-in, not "no SaaS".** The wedge isn't "never a managed
  service" — it's _choice_. The same code runs two ways: self-host it on your own
  Cloudflare account (free, open source, your data), or let **Lunora Cloud** run it for
  you (managed). You're never forced onto our cloud the way Convex forces you onto
  theirs — you can always take the OSS and self-host. That freedom is the promise. Sell
  Cloud on **convenience** (managed Studio, observability, point-in-time restore,
  team/RBAC, one-click deploy + CI, backups, a human on support), never on lock-in.
  _(Open decision #6: whether Cloud runs on Lunora's infra or deploys into the
  customer's own Cloudflare account — resolve before Cloud-facing copy ships.)_
- **Investment is deliberately deferred.** The product doesn't exist yet. What we do
  now: reserve the name (here), use the aurora-mark variant + a one-field waitlist
  CTA on the docs site, and nothing more. No pricing brand, dashboard identity, or
  landing system until there's a product to attach them to.

## Do

- Use the moon mark alone where space is tight (favicon, CLI banner, small badges);
  pair it with the lowercase wordmark for any wider lockup.
- Keep generous clear space around the mark (≥ the width of one stroke).
- Use the **ink** fill in monochrome contexts; reserve the **aurora gradient** for
  expressive moments (favicon, OG, hero).
- Let exactly **one** aurora glow live per view — ideally Aurora Violet behind the
  mark or the hero.
- Keep structural chrome **sharp** (`rounded-none`); depth comes from a hairline,
  not a shadow.

## Don't

- Don't tint the mark **Cloudflare orange** (`#F38020`) or any color that implies a
  Cloudflare product.
- Don't flood a surface with aurora — it's an accent (≤ ~10% of a view), not a
  background.
- Don't add a drop shadow, bevel, or glassy blur to flat panels — use the hairline;
  the only thing that glows is the aurora.
- Don't lock the wordmark into uppercase or title case.
- Don't redraw the moon — derive every copy from `.github/assets/lunora.svg`.
- Don't reach for the gradient ribbon anywhere but _the_ focal moment, or it stops
  being special.

## Voice

- Direct, technical, not marketing-y. Lunora is for engineers who already know what
  a Durable Object is.
- Be honest about the alpha status and the trade-offs (fewer batteries than Convex;
  you own the infra).
- Avoid superlatives. **Show, don't claim** — lead with code, demos, and the launch
  video.

## Where the brand is applied

`design-tokens/tokens.css` is the single source for color/type/radius; it's
`@import`ed by the docs site (`apps/docs`) and the Studio (`packages/studio`,
mirrored under its own namespace). The Remotion video project — now in the separate
[`lunora-marketing`](https://github.com/anolilab/lunora-marketing) repo — renders a
pure-monochrome white-on-black treatment with one aurora-violet glow behind the
mark. Marketing copy lives in [`social/`](./social/).
