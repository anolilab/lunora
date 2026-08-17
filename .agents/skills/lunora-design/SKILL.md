---
name: lunora-design
description: This skill should be used when the user explicitly says "Lunora style", "Lunora design", "/lunora-design", or directly asks to use/apply the Lunora design system. NEVER trigger automatically for generic UI or design tasks.
version: 1.0.0
allowed-tools: [Read, Write, Edit, Glob, Grep]
---

# Lunora UI/UX Design System

A senior product designer's toolkit trained in Swiss typography, industrial design (Braun, Teenage Engineering), and modern interface craft. Monochromatic, typographically driven, information-dense without clutter. Dark and light mode with equal rigor.

**Before starting any design work, declare which fonts are required and how to load them** (see `references/tokens.md` Section 1). Never assume fonts are already available.

---

## 1. DESIGN PHILOSOPHY

- **Subtract, don't add.** Every element must earn its pixel. Default to removal.
- **Structure is ornament.** Expose the grid, the data, the hierarchy itself.
- **Monochrome is the canvas.** Color is an event, not a default — except when encoding data status (see Section 3).
- **Type does the heavy lifting.** Scale, weight, and spacing create hierarchy — not color, not icons, not borders.
- **Both modes are first-class.** Dark mode (primary): Night — cool blue-violet near-black. Light mode: Ivory — cool off-white. Neither is "derived" — both get full design attention. Ask the user which mode to start with.
- **Industrial warmth.** Technical and precise, but never cold. A human hand should be felt.

---

## 2. CRAFT RULES — HOW TO COMPOSE

### 2.1 Visual Hierarchy: The Three-Layer Rule

Every screen has exactly **three layers of importance.** Not two, not five. Three.

| Layer | What | How |
|-------|------|-----|
| **Primary** | The ONE thing the user sees first. A number, a headline, a state. | Geist Sans at display size. `--text-display`. 48–96px breathing room. |
| **Secondary** | Supporting context. Labels, descriptions, related data. | Geist Sans at body/subheading. `--text-primary`. Grouped tight (8–16px) to the primary. |
| **Tertiary** | Metadata, navigation, system info. Visible but never competing. | Geist Mono at caption/label. `--text-secondary` or `--text-disabled`. ALL CAPS. Pushed to edges or bottom. |

**The test:** Squint at the screen. Can you still tell what's most important? If two things compete, one needs to shrink, fade, or move.

**Common mistake:** Making everything "secondary." Evenly-sized elements with even spacing = visual flatness. Be brave — make the primary absurdly large and the tertiary absurdly small. The contrast IS the hierarchy.

### 2.2 Font Discipline

Per screen, use maximum:
- **2 font families** (Geist Sans + Geist Mono.)

**Geist is settled, including for display.** Reference sites in this space use
wider geometric grotesques, and a display face is the first thing that looks
"missing" when comparing side by side. It is not: Geist at 700 with the
negative tracking in 2.10 is the tuned setting, and `--font-display` /
`--font-heading` alias Geist deliberately rather than by omission. Do not
propose swapping the display face as a fix for a page that looks off — measure
the scale first (see 3.1), because a dropped size utility looks exactly like a
wrong typeface.
- **3 font sizes** (one large, one medium, one small)
- **2 font weights** (Regular + one other — usually Light or Medium, rarely Bold)

Think of it as a budget. Every additional size/weight costs visual coherence. Before adding a new size, ask: can I create this distinction with spacing or color instead?

| Decision | Size | Weight | Color |
|----------|:---:|:---:|:---:|
| Heading vs. body | Yes | No | No |
| Label vs. value | No | No | Yes |
| Active vs. inactive nav | No | No | Yes |
| Hero number vs. unit | Yes | No | No |
| Section title vs. content | Yes | Optional | No |

**Rule of thumb:** If reaching for a new font-size, it's probably a spacing problem. Add distance instead.

### 2.3 Spacing as Meaning

Spacing is the primary tool for communicating relationships.

```
Tight (4–8px)   = "These belong together" (icon + label, number + unit)
Medium (16px)    = "Same group, different items" (list items, form fields)
Wide (32–48px)   = "New group starts here" (section breaks)
Vast (64–96px)   = "This is a new context" (hero to content, major divisions)
```

**If a divider line is needed, the spacing is probably wrong.** Dividers are a symptom of insufficient spacing contrast. Use them only in data-dense lists where items are structurally identical.

### 2.4 Container Strategy (prefer top)

1. **Spacing alone** (proximity groups items)
2. A single divider line
3. A subtle border outline
4. A surface card with background change

Each step down adds visual weight. Use the lightest tool that works. Never box the most important element — let it float on the background.

### 2.5 Color as Hierarchy

In a monochrome system, the gray scale IS the hierarchy. Max 4 levels per screen:

```
--text-display (100%) → Hero numbers. One per screen.
--text-primary (90%)  → Body text, primary content.
--text-secondary (60%) → Labels, captions, metadata.
--text-disabled (40%) → Disabled, timestamps, hints.
```

**The aurora ramp (cyan → violet → rose) is not part of the gray hierarchy.** It's light, not paint — an event, not a default. Aurora Violet is the primary glow (the closest thing to a brand color); cyan = info/active, rose = emphasis. If >~10% of a view is aurora, pull back. Reach for the full **gradient ribbon** only on *the* focal moment (hero clause, active state, focus ring).

**Emphasis is achromatic.** The loudest control on a view — the primary button, the strongest interactive state — is *bright*, not saturated. It takes near-white on night (near-black on ivory), not the accent. Spending the accent on the primary button is the most common way a Lunora surface drifts colourful: the button is on every view, so the accent stops being an event. Keep a distinct `emphasis` / `on-emphasis` token pair for this and leave the accent for the moments below.

**The accent budget, concretely.** On a given view, chromatic colour is allowed in:

1. one atmospheric field (a page-header colour field, one soft glow),
2. numeric indices and section counters,
3. exactly one highlighted cell per grid,
4. focus and active states,
5. a data status value (see below).

Everything else is grey. Anything not on that list wanting colour is asking for `emphasis` or `ink`.

**Measure it, don't eyeball it.** Colour creep is invisible while you add it, one component at a time. Count chromatic nodes in the rendered page and keep the ratio under ~10%:

```js
// In the browser console on the rendered page.
const chromatic = [...document.querySelectorAll("*")].filter((el) => {
    const m = getComputedStyle(el).color.match(/\d+/g);
    if (!m) return false;
    const [r, g, b] = m.map(Number);
    return Math.max(r, g, b) - Math.min(r, g, b) > 40; // chromatic, not grey
});
console.log((chromatic.length / document.querySelectorAll("*").length) * 100);
```

A landing page that reads "too colourful" usually measures 9-12%. The same page after moving ticks, arrows, and per-card icons to grey measures 5-6%, and the accent starts meaning something again.

**Data status colors** (success green, warning amber, error red) are exempt from the aurora-only rule when encoding data values. Apply color to the **value itself**, not labels or row backgrounds. See `references/tokens.md` for the full color system.

### 2.6 Consistency vs. Variance

**Be consistent in:** Font families, label treatment (always Geist Mono ALL CAPS), spacing rhythm, color roles, component shapes, alignment.

**Break the pattern in exactly ONE place per screen:** An oversized number, a circular widget among rectangles, an aurora-ribbon clause among Moonlight text, a vast gap where everything else is tight.

This single break IS the design. Without it: sterile grid. With more than one: visual chaos.

### 2.7 Compositional Balance

**Asymmetry > symmetry.** Centered layouts feel generic. Favor deliberately unbalanced composition:
- **Large left, small right:** Hero metric + metadata stack.
- **Top-heavy:** Big headline near top, sparse content below.
- **Edge-anchored:** Important elements pinned to screen edges, negative space in center.

Balance heavy elements with more empty space, not with more heavy elements.

### 2.8 The Lunora Vibe

1. **Confidence through emptiness.** Large uninterrupted background areas. Resist filling space.
2. **Precision in the small things.** Letter-spacing, exact gray values, 4px gaps. Micro-decisions compound into craft.
3. **Data as beauty.** `36GB/s` in Geist Mono at 48px IS the visual. No illustrations needed.
4. **Mechanical honesty.** Controls look like controls. A toggle = physical switch. A gauge = instrument.
5. **One moment of surprise.** An aurora-ribbon headline clause. A circular widget. A glowing aurora dot. Restraint makes the one expressive moment powerful.
6. **Percussive, not fluid.** Imagine UI sounds: click not swoosh, tick not chime. Design transitions that feel mechanical and precise.

### 2.9 Visual Variety in Data-Dense Screens

When 3+ data sections appear on one screen, vary the visual form:

| Form | Best for | Weight |
|------|----------|--------|
| Hero number (large Geist Sans/Geist Mono) | Single key metric | Heavy — use once |
| Segmented progress bar | Progress toward goal | Medium |
| Concentric rings / arcs | Multiple related percentages | Medium |
| Inline compact bar | Secondary metrics in rows | Light |
| Number-only with status color | Values without proportion | Lightest |
| Sparkline | Trends over time | Medium |
| Stat row (label + value) | Simple data points | Light |

Lead section → heaviest treatment. Secondary → different form. Tertiary → lightest. The FORM varies, the VOICE stays the same.

### 2.10 Marketing Surfaces (landing, docs hub, product pages)

Sections 2.1–2.9 assume a product screen. Marketing surfaces carry the same
voice with three additional structures. They are not decoration; each one is
load-bearing, and half-applying them is what makes a page read as generic.

**Page header.** A full-bleed saturated colour field with a dark panel set into
its lower-left, overhanging the field's bottom edge. The overhang *is* the
composition — a panel that sits neatly inside the band reads as a banner with a
box on it. Build it by pulling the panel up with a negative margin while it
stays in normal flow, never by positioning it absolutely: in flow the panel's
own height sets the overhang and the following content is pushed down for free,
where absolute positioning needs a spacer kept in sync by hand with a height
that changes per breakpoint and per content.

The field is **one brand colour with depth**, not three in equal measure.
Violet carries it; cyan and rose are edge blooms for dimension. An even
three-way split reads as a stock mesh gradient and belongs to no brand. Punch a
canvas-coloured halftone dot matrix through it (≈9px grid) so it resolves from
cells rather than blurring.

The navbar sits over this field. Aurora accents are mid-lightness, so dark ink
on them fails contrast — keep light ink and guarantee it with a top scrim
gradient rather than flipping the nav to dark.

**Numbered sections.** Each band opens with an index stacked over a category
label (`01` / `FRAMEWORK`) in the left column, title and lead beside it. The
label says what *kind* of section it is, which the title rarely does. Index in
accent, label in faint grey.

**Hairline grid.** Cells separated by real 1px lines, not whitespace: the
container paints the hairline colour and a 1px gap lets it through between
opaque cells. Two consequences that bite:

- cells must stay **opaque** — a translucent cell shows the hairline across its
  whole face instead of only at the seams;
- a cell must be the grid's **direct child** — wrap one in a transparent reveal
  animation and the wrapper becomes the grid item, with the same result.

**Type scale for marketing.** The 3-sizes-per-screen budget in 2.2 governs
product screens. Marketing surfaces use the published scale, capped so headings
stop growing on wide monitors while gutters stay fluid:

| Role | Size | Line height | Tracking |
|---|---:|---:|---:|
| display | 3.3rem cap | 0.95 | -0.04em |
| h1 | 2.75rem cap | 1.05 | -0.04em |
| h2 | 2.5rem cap | 1.05 | -0.035em |
| h3 | 1.4375rem cap | 1.08 | -0.028em |
| body | 0.9375rem | 1.55 | -0.01em |
| blurb | 0.8125rem | 1.5 | -0.01em |
| kicker (mono, caps) | 0.6875rem | 1.2 | 0.12em |
| micro (mono, caps) | 0.625rem | 1.5 | 0.18em |

Negative tracking on display type is not optional. Large text set at default
tracking is the single clearest tell of an untuned page.

**Vary the layout family.** A landing page that uses the hairline grid for four
consecutive bands reads monotonous however good each band is. Rotate: hairline
grid, rule-topped columns, a real table, a disclosure list, a full-bleed panel.
No family twice in a row.

---

## 3. ANTI-PATTERNS — WHAT TO NEVER DO

- No gradients in UI chrome — the **one** exception is the aurora ribbon on the focal accent (hero clause, active underline, focus ring)
- No shadows. Depth = value step + one hairline. One **atmospheric aurora glow** per view max (soft radial behind a hero) — never on buttons.
- No skeleton loading screens. Use `[LOADING...]` text or segmented spinner.
- No toast popups. Use inline status text: `[SAVED]`, `[ERROR: ...]`
- No sad-face illustrations, cute mascots, or multi-paragraph empty states
- No zebra striping in tables
- No filled icons, multi-color icons, or emoji as UI
- No parallax, scroll-jacking, or gratuitous animation
- No spring/bounce easing. Use subtle ease-out only.
- **Sharp corners** (`rounded-none`) on structural chrome — nav, console, buttons, cards, panels. Small radii (4–8px) only inside dense data (badges, table cells, chips). Never rounded glassy cards.
- Data visualization: differentiate with **opacity** (100%/60%/30%) or **pattern** (solid/striped/dotted) before introducing color.

---

## 3.1 IMPLEMENTATION TRAPS — THINGS THAT FAIL SILENTLY

These do not throw, do not fail a type check, and do not fail a lint. They ship
a page that looks subtly wrong for reasons no one can point at.

**`tailwind-merge` eats named type-scale utilities.** When the scale is named
(`text-h2`, `text-blurb`) rather than sized (`text-lg`), tailwind-merge cannot
distinguish it from a colour utility. It sees `cn("text-h3", "text-ink")`,
assumes both are text colours, resolves the "conflict" in favour of the last
one, and **drops the size**. Headings then render at the browser default while
the class list still looks right in the source.

This is not hypothetical: it shipped, and every `h3` on a landing page rendered
at 16px instead of 23px until it was measured.

Register the names as a font-size group, once, where `cn` is defined:

```ts
const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            "font-size": [{ text: ["display", "h1", "h2", "h3", "body", "blurb", "kicker", "micro"] }],
        },
    },
});
```

Any token added to `--text-*` must be added here too. Verify with a direct
assertion (`twMerge("text-h3", "text-ink")` must keep both) rather than trusting
that it looks fine.

**`@theme` vs `@theme inline`.** Tokens declared in a plain `@theme` block are
inlined at build time, so a runtime theme swap or a `[data-theme]` override does
nothing. Use `@theme inline` when the value references another custom property,
so utilities compile to `var(--…)`.

**Tailwind namespace names are not free-form.** `--container-shell` produces
`max-w-shell`, not `max-w-container-shell`. Check the generated utility exists
before building a layout on it; a missing utility is simply no styling, not an
error.

**Verify the rendered page, not the source.** Every trap above is invisible in
the JSX and obvious in `getComputedStyle`. Before calling a surface done, read
back the computed font sizes, line heights, and tracking of h1/h2/h3/body and
compare them to the table in 2.10.

---

## 4. WORKFLOW

1. **Declare fonts** — tell the user which fonts to load (see `references/tokens.md`)
2. **Ask mode** — dark or light? Neither is default.
3. **Sketch hierarchy** — identify the 3 layers before writing any code
4. **Compose** — apply craft rules (Sections 2.1–2.10; 2.10 for marketing surfaces)
5. **Check tokens** — consult `references/tokens.md` for exact values
6. **Build components** — consult `references/components.md` for patterns
7. **Adapt to platform** — consult `references/platform-mapping.md` for output conventions
8. **Measure the result** — read back computed type and the chromatic ratio (2.5, 2.10). Section 3.1 lists what fails silently; none of it is visible in the source.

---

## 5. REFERENCE FILES

For detailed token values, component specs, and platform-specific guidance:

- **`references/tokens.md`** — Fonts, type scale, color system (dark + light), spacing scale, radius/surface, motion, iconography, texture motifs
- **`references/components.md`** — Cards, buttons, inputs, lists, tables, nav, tags, segmented controls, progress bars, charts, widgets, overlays, state patterns
- **`references/platform-mapping.md`** — HTML/CSS, SwiftUI, React/Tailwind, Paper output conventions

**Canonical token source.** The shipped values live in `marketing/design-tokens/`
(`tokens.css` for Tailwind v4, `tokens.ts` for JS) with intent in
`marketing/design-tokens/DESIGN.md`. Those are authoritative; the references here
restate them for the methodology. When generating real code, import the tokens
rather than re-typing hex values.

---

*Adapted under the MIT License from the "Nothing Design Skill" by Dominik Martin
(https://github.com/dominikmartn/nothing-design-skill). The craft methodology is
the original author's; the palette, typeface, corners, and accent rules were
reconciled to Lunora's established design language (`marketing/design-tokens/DESIGN.md`).
See `LICENSE`.*
