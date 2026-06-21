# Lunora Design Skill

The project's design language as a [Claude Code](https://claude.ai/code) skill:
typographic, instrument-precise, nocturnal — Lunora's "Luna + Aurora" palette and
the Geist typeface.

Invoke with `/lunora-design` or say "Lunora style" / "Lunora design". It does
**not** trigger automatically for generic UI work.

## What changed from the source

This is adapted from the **Nothing Design Skill** by Dominik Martin
(https://github.com/dominikmartn/nothing-design-skill), used under the MIT
License. The craft methodology (three-layer hierarchy, font discipline, spacing
as meaning, data-as-beauty, anti-patterns) is the original author's. It was
reconciled to Lunora's established design language
([`marketing/design-tokens/DESIGN.md`](../../../marketing/design-tokens/DESIGN.md)):

- **Color** — Nothing's OLED-black + single-red monochrome → Lunora's **Luna +
  Aurora**: cool blue-violet Night neutrals (midnight/moonlight) + the **aurora
  ribbon** (cyan → violet → rose). Aurora Violet is the primary glow; cyan =
  info/active, rose = emphasis; status colors (green/amber/red) are for data
  encoding only.
- **Typeface** — Doto / Space Grotesk / Space Mono → **Geist Sans + Geist Mono**
  (Lunora's fonts across docs, Studio, and the wordmark).
- **Corners** — Nothing's pills/technical radii → **sharp** (`rounded-none`) on
  structural chrome; small radii only inside dense data.
- **Gradients/glow** — the aurora ribbon is the one sanctioned gradient (focal
  accent only), and one atmospheric aurora glow per view is allowed.

The shipped token values are not duplicated here — they live in
[`marketing/design-tokens`](../../../marketing/design-tokens) and this skill
defers to them.

## Files

| File | |
|------|---|
| `SKILL.md` | Design philosophy, craft rules, workflow |
| `references/tokens.md` | Colors, fonts, spacing, motion tokens |
| `references/components.md` | Buttons, cards, lists, tables, overlays |
| `references/platform-mapping.md` | CSS, SwiftUI, React output mappings |
| `LICENSE` | MIT (original author's notice retained) |

## License

MIT — see `LICENSE`.
