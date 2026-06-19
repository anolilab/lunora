# Lunora — Design Language

> The visual spec for the Lunora docs/marketing site. Source of truth for color,
> surface, type, and motion. Tokens live in `src/styles/app.css`; this document
> explains the _intent_ behind them.

## 1. Concept

**Lunora = Luna + Aurora.** A backend that runs globally, at the edge, while you
sleep — so the identity is **nocturnal and luminous**: a deep night sky, cool
moonlight neutrals, and a single **aurora ribbon** (cyan → violet → rose) used
sparingly for energy.

The structure stays **refined-brutalist** to match the product surface (sharp
rectangles, hairline rules, mono labels — see the navbar and hero console). The
_color_ is where the warmth/luminosity lives. Sharp edges, soft light.

Three words: **nocturnal · luminous · precise.**

Avoid: pure neutral grays, the generic "dark mode blue" (`#3b82f6`), warm/amber
accents, rounded glassy cards. Those read as every-other-dev-tool.

## 2. Color

### Night & moonlight (neutrals)

| Token                     | HSL / hex          | Role                                                                                                                                         |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dark-coal`             | `#0e0e11`          | Eclipse — the charcoal page/body base, used across the landing and docs (also written as the literal `bg-[#0e0e11]` in marketing components) |
| `--coal` / `--background` | `hsl(240 14% 6%)`  | Midnight — fumadocs docs base (~`#0d0d12`)                                                                                                   |
| (raised surface)          | `hsl(240 14% 9%)`  | Panels, popovers, consoles                                                                                                                   |
| `--foreground`            | `hsl(228 30% 96%)` | Moonlight — primary text (cool, not pure white)                                                                                              |
| `--ivory`                 | `hsl(228 32% 97%)` | Moonlight panel (inverted nav bar, menu sheets)                                                                                              |
| `--stone`                 | `hsl(228 12% 86%)` | Muted moonlight                                                                                                                              |

The night surfaces carry a subtle **cool blue-violet** cast (hue ~240) instead of
neutral coal — it reads as sky, not soot. Keep the cast subtle so it still sits
next to true black without clashing.

### Aurora (accents)

A single luminous ramp. Use as a **gradient ribbon** for headlines/accents, or
individually for state (cyan = info/active, violet = primary glow, rose =
emphasis). Never flood a surface with these — they are light, not paint.

| Token              | HSL                | Aurora name   |
| ------------------ | ------------------ | ------------- |
| `--sky-sapphire`   | `hsl(186 84% 56%)` | Aurora Cyan   |
| `--royal-amethyst` | `hsl(256 72% 68%)` | Aurora Violet |
| `--crimson-energy` | `hsl(330 80% 64%)` | Aurora Rose   |

> **Legacy names.** The token names (`sky-sapphire`, `royal-amethyst`,
> `crimson-energy`) predate this system and now alias the aurora ramp. New code
> should think in terms of **Aurora Cyan / Violet / Rose**; the names are kept
> only so existing usages re-skin for free. Rename in a later sweep.

**Aurora ribbon** (the signature gradient):
`linear-gradient(to right, Aurora Cyan → Aurora Violet → Aurora Rose)`.
Used on the hero headline accent, the active-feature underline, and focus rings.

**Primary glow** is Aurora Violet — moonlit, the closest thing to a brand color.

### Semantic (shadcn)

`--primary` (dark) = Moonlight (`hsl(228 32% 97%)`) so solid CTAs / the inverted
nav bar stay light with dark (`--coal`) text. Keep `--destructive` and chart
colors as-is unless a chart needs the aurora ramp.

## 3. Surface & elevation

Depth comes from **value steps + a single hairline**, not shadows-on-everything:

- Page: `--dark-coal`. Section/base: `--background`.
- Raised (panel/console/popover): `hsl(240 14% 9%)`, separated by a **hairline**
  `border-white/10` (outer) or `border-white/[0.08]` (inner divider).
- One **atmospheric glow** per view max — a soft radial of Aurora Violet/Cyan at
  low alpha behind the hero. Glows are for atmosphere, not for buttons.
- Corners: **sharp** (`rounded-none`) on structural chrome (nav, console,
  buttons). Small radii (`rounded`/`rounded-md`) allowed only inside dense data
  (badges, table cells).

## 4. Typography

- Display/UI: the site's existing sans (tight tracking on big headings —
  `tracking-tighter`, `leading-[1.02]`). Headlines may carry the aurora ribbon on
  a key clause, the rest in Moonlight.
- Code/labels: monospace, `text-[11px]`–`text-[13px]`, used for file tabs, window
  labels, the install command, and feature indices (`01`). Mono is a recurring
  motif — it signals "this is real code."

## 5. Motion

- One orchestrated load: staggered fade-up (`fade(delay)` 0.1→0.5).
- Reactive accents pulse, don't bounce: opacity/`backgroundColor` transitions,
  `duration` 0.3–1.2s, `ease-out`.
- Respect `prefers-reduced-motion` for any looping/auto-playing demo.
- The aurora is the only thing allowed to "glow" (animate-glow-pulse on small dots).

## 6. Usage rules

1. Aurora is an accent, not a background. If more than ~10% of a view is aurora,
   pull back.
2. Text is Moonlight on Night, or Coal on Moonlight — never gray-on-gray.
3. Structural chrome is sharp; light is soft. Don't round the console or add drop
   shadows to flat panels — use the hairline.
4. One glow per view.
5. Reach for the gradient ribbon only on _the_ focal moment (headline, active
   state), so it stays special.

## 7. Marketing layout (the section frame)

The landing and package pages share one structural frame:

- **Full-bleed dividers, container content.** Each `<section>` is full width with
  a `border-t border-white/[0.08]` top rule that spans the viewport, but its
  content sits in a centered `mx-auto max-w-6xl` column. The column runs flush to
  its edges (`px-5 lg:px-0`) so content meets the frame, not a gutter.
- **Vertical guide lines.** A single `z-20` absolute overlay draws `border-x`
  lines down the container edges, full page height, so the centered column reads
  as a framed plane. Grids inside use `lg:border-x-0` to avoid doubling the guide.
- **Hatch spacers.** Sections are separated by a `HatchSpacer` band — a thin
  `border-t` over a 135° repeating-line texture on the charcoal base.
- **Sharp buttons.** Pills/CTAs are `rounded-none` (see §3); the shared `Pill`
  primitive is square, primary = solid white-on-black, ghost = hairline border.
- **Page root** is `bg-[#0e0e11]` with `overflow-x-clip` so full-bleed elements
  can use `w-screen` without a horizontal scrollbar.

## 8. Docs (fumadocs)

The docs render through fumadocs with the charcoal base unified to `#0e0e11`
(`--color-dark-coal`). Author docs with fumadocs MDX components rather than raw
markdown where it adds clarity:

- **`<Callout type="info|warn|error">`** for notes, gotchas, and preview flags —
  never a raw `>` blockquote.
- **`<Tabs>`** for package-manager install commands (pnpm / npm / yarn / bun).
- **`<Steps>`/`<Step>`** for sequential procedures (getting-started, tutorials).
- Code blocks are syntax-highlighted via shiki (`github-dark` / `github-light`).

A build-time gate (`scripts/check-doc-imports.mjs`) verifies every `ts`/`tsx`
snippet's imports resolve to real package exports.
