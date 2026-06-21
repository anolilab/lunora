# Lunora Design System — Tokens

> **Canonical source.** The shipped values live in `marketing/design-tokens/`
> (`tokens.css` for Tailwind v4, `tokens.ts` for JS) and the intent is documented
> in `marketing/design-tokens/DESIGN.md`. This file restates them for the design
> methodology — if they ever disagree, `DESIGN.md` + `tokens.css` win.

Identity: **nocturnal · luminous · precise** (Luna + Aurora). Cool blue-violet
neutrals, a single aurora ribbon (cyan → violet → rose) used sparingly as light,
sharp corners on structural chrome.

## 1. TYPOGRAPHY

### Font Stack

| Role | Font | Fallback | Weight |
|------|------|----------|--------|
| **Display** | `"Geist Sans"` | `ui-sans-serif, system-ui, sans-serif` | Light 300, Medium 500, tight tracking |
| **Body / UI** | `"Geist Sans"` | `ui-sans-serif, system-ui, sans-serif` | Light 300, Regular 400, Medium 500, Bold 700 |
| **Data / Labels** | `"Geist Mono"` | `ui-monospace, SFMono-Regular, monospace` | Regular 400, Bold 700 |

**Why these fonts:** Geist Sans + Geist Mono are Lunora's typefaces — already used across the docs site, Studio, and the wordmark. Two families: clean, technical, neutral. There is no dedicated dot-matrix display face; hero display uses Geist Sans at large tight tracking.

### Type Scale

| Token | Size | Line Height | Letter Spacing | Use |
|-------|------|-------------|----------------|-----|
| `--display-xl` | 72px | 1.0 | -0.03em | Hero numbers, time displays |
| `--display-lg` | 48px | 1.05 | -0.02em | Section heroes, percentages |
| `--display-md` | 36px | 1.1 | -0.02em | Page titles |
| `--heading` | 24px | 1.2 | -0.01em | Section headings |
| `--subheading` | 18px | 1.3 | 0 | Subsections |
| `--body` | 16px | 1.5 | 0 | Body text |
| `--body-sm` | 14px | 1.5 | 0.01em | Secondary body |
| `--caption` | 12px | 1.4 | 0.04em | Timestamps, footnotes |
| `--label` | 11px | 1.2 | 0.08em | ALL CAPS monospace labels |

### Typographic Rules

- **Display (Geist Sans):** 36px+ only, tight tracking, light/medium weight, never for body text. Headlines may carry the aurora ribbon on **one** key clause; the rest stays Moonlight.
- **Labels:** Always Geist Mono, ALL CAPS, 0.06–0.1em spacing, 11–13px ("instrument panel" labels). Mono signals "this is real code."
- **Data/Numbers:** Always Geist Mono. Units as `--label` size, slightly raised, adjacent.
- **Hierarchy:** display (Geist Sans) > heading (Geist Sans) > label (Geist Mono caps) > body (Geist Sans). Four levels max.

---

## 2. COLOR SYSTEM

**Concept (DESIGN.md §1–2):** a deep night sky in cool moonlight neutrals, with a
single **aurora ribbon** for energy. Color is light, not paint. **Avoid:** pure
neutral grays, the generic "dark-mode blue" (`#3b82f6`), warm/amber *accents*,
rounded glassy cards.

### Night & moonlight (neutrals — the canvas)

| Token | Value | Role |
|-------|-------|------|
| `--dark-coal` | `#0e0e11` | Eclipse — page/body base |
| `--coal` / `--background` | `hsl(240 14% 6%)` | Midnight — section base |
| (raised surface) | `hsl(240 14% 9%)` | Panels, popovers, consoles |
| `--foreground` / Moonlight | `hsl(228 30% 96%)` | Primary text (cool, not pure white) |
| `--stone` | `hsl(228 12% 86%)` | Muted moonlight |
| `--ivory` | `hsl(228 32% 97%)` | Moonlight panel (inverted nav, sheets) |

The night surfaces carry a subtle **cool blue-violet cast** (hue ~240) — sky, not
soot. Depth comes from **value steps + a single hairline** (`border-white/10`
outer, `border-white/[0.08]` inner), never stacked shadows.

### Text hierarchy (the gray scale IS the hierarchy)

```
text-display  → Moonlight hsl(228 32% 98%)  → Hero numbers. One per screen.
text-primary  → Moonlight hsl(228 30% 96%)  → Body, primary content.
text-secondary→ hsl(218 11% 65%)            → Labels, captions, metadata.
text-disabled → hsl(220 9% 46%)             → Disabled, timestamps, hints.
```

Text is **Moonlight on Night, or Coal on Moonlight — never gray-on-gray.**

### Aurora (the accent ramp)

A single luminous ramp. Use as a **gradient ribbon** on the focal moment, or the
stops individually for state. Never flood a surface — if >~10% of a view is
aurora, pull back.

| Token | Value | Aurora name | Role |
|-------|-------|-------------|------|
| `--sky-sapphire` | `hsl(186 84% 56%)` | Aurora Cyan | Info / active / links |
| `--royal-amethyst` | `hsl(256 72% 68%)` | Aurora Violet | **Primary glow — the brand color** |
| `--crimson-energy` | `hsl(330 80% 64%)` | Aurora Rose | Emphasis |

> The token names predate the aurora naming and now alias the ramp. New code
> should think **Aurora Cyan / Violet / Rose**.

**Aurora ribbon** (the signature gradient): `linear-gradient(to right, Aurora Cyan → Aurora Violet → Aurora Rose)`. Used on the hero headline accent, the active-feature underline, and focus rings — *the* focal moment only, so it stays special.

### Data status colors

Exempt from the aurora-only rule **when encoding data values** — they are
semantics, not decoration. Apply color to the **value itself**, not labels or row
backgrounds. Labels stay `text-secondary`; trend arrows inherit value color.

| Token | Value | Meaning |
|-------|-------|---------|
| `--success` | `hsl(160 60% 45%)` | Good / in range / connected |
| `--warning` | `hsl(38 92% 55%)` | Caution / pending. **The one place amber is allowed — data status only, never as a brand or decorative accent.** |
| `--destructive` / `--error` | `hsl(0 84% 60%)` | Bad / over limit / destructive |
| `--info` | Aurora Cyan | Informational |

### Dark / Light

Dark is the primary canvas (instrument panel in a dark room — Night surfaces,
Moonlight data glowing) and matches the docs site's charcoal look:

- **Base** = eclipse `#0e0e11` (`hsl(240 10% 6%)`); raised surfaces a single value
  step lighter (`card` `hsl(240 12% 8%)`, `popover` `hsl(240 13% 9%)`).
- **Borders are white-alpha hairlines** — `--border: hsl(0 0% 100% / 0.08)`,
  `--input: hsl(0 0% 100% / 0.12)` — never a chunky mid-gray fill. This is what
  makes the dark UI read crisp rather than muddy.
- **Fills** (`secondary`/`muted`/`accent`) are *subtle* dark steps
  (`hsl(240 9% 13–15%)`), not light gray blocks.
- Text: Moonlight `hsl(228 30% 96%)`; muted `hsl(228 12% 64%)`. Focus ring = Aurora Violet.

Light is a printed-manual inverse: Ivory paper (`hsl(228 32% 97%)`), Coal ink,
white cards as subtle elevation without shadows. Aurora ramp, status colors,
labels, fonts, type scale, spacing, and shapes are **identical across modes**.
Full per-mode values: `marketing/design-tokens/tokens.css`.

---

## 3. SPACING

### Spacing Scale (8px base)

| Token | Value | Use |
|-------|-------|-----|
| `--space-2xs` | 2px | Optical adjustments only |
| `--space-xs` | 4px | Icon-to-label gaps, tight padding |
| `--space-sm` | 8px | Component internal spacing |
| `--space-md` | 16px | Standard padding, element gaps |
| `--space-lg` | 24px | Group separation |
| `--space-xl` | 32px | Section margins |
| `--space-2xl` | 48px | Major section breaks |
| `--space-3xl` | 64px | Page-level vertical rhythm |
| `--space-4xl` | 96px | Hero breathing room |

---

## 4. RADIUS & SURFACE

- **Corners are sharp** (`rounded-none`) on structural chrome — nav, console,
  buttons, cards, panels. Small radii (`--radius-sm`/`-md`, 4–8px) are allowed
  **only inside dense data** (badges, table cells, chips). Never rounded glassy
  cards.
- `--radius: 0.5rem` defines the small-radius steps (`-sm` = calc(r - 4px),
  `-md` = calc(r - 2px), `-lg` = r) for those dense-data exceptions.
- Depth = value step + **one hairline**, not shadows. One **atmospheric glow**
  per view max — a soft radial of Aurora Violet/Cyan at low alpha behind a hero.
  Glows are for atmosphere, never on buttons.

---

## 5. MOTION & INTERACTION

- **Duration:** 150–250ms micro, 300–1200ms transitions/reveals.
- **Easing:** ease-out (`cubic-bezier(0.25, 0.1, 0.25, 1)`). No spring/bounce.
- Prefer opacity over position. Elements fade, don't slide. Reactive accents
  **pulse, don't bounce** (opacity / background-color).
- One orchestrated load: staggered fade-up (`fade(delay)` 0.1 → 0.5).
- The aurora is the only thing allowed to "glow" (`animate-glow-pulse` on small
  dots). Respect `prefers-reduced-motion` for any looping/auto-playing demo.
- No parallax, scroll-jacking, gratuitous animation.

---

## 6. ICONOGRAPHY

- Monoline, 1.5px stroke, no fill. 24x24 base, 20x20 live area. Round caps/joins.
- Color inherits text color. Max 5–6 strokes.
- Preferred: Lucide (thin), Phosphor (thin). Never filled or multi-color.

---

## 7. TEXTURE MOTIFS

Lunora-native textures for depth, in order of preference:

- **Hairlines** — full-bleed `border-t border-white/[0.08]` section rules; vertical
  guide lines down a centered container's edges.
- **Hatch spacers** — a thin band of 135° repeating-line texture on the charcoal
  base between sections.
- **Grain** — a fractal-noise overlay at ~0.03 opacity for subtle depth.
- **Dot grid** (optional) — uniform 12–16px radial-dot background for data-viz
  heat maps or decorative panels. Dots 1–2px, opacity 0.1–0.2 for backgrounds.

```css
.dot-grid {
  background-image: radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px);
  background-size: 16px 16px;
}
```

Never as a container border or button style.
