# Landing page variants

Four fully-functional landing pages, each on its own route, sharing the Luna+Aurora
design language (see `apps/docs/DESIGN.md`), navbar, and footer. Pick one wholesale or
mix sections across them.

| Route | Name  | Inspiration       | Hero                                 | Body                                 | Best when…                                              |
| ----- | ----- | ----------------- | ------------------------------------ | ------------------------------------ | ------------------------------------------------------- |
| `/v1` | Lumen | Vercel / Geist    | Centered, single aurora accent       | 3-col feature grid → CTA             | You want maximum restraint and whitespace               |
| `/v2` | Prism | Stripe            | Split, vivid gradient + tilted frame | Two alternating product scenes → CTA | You want color and a premium, marketing-forward feel    |
| `/v3` | Nova  | Supabase          | Split, syntax-highlighted code panel | Mixed-size feature bento → CTA       | You want to lead with the developer experience / code   |
| `/v4` | Folio | Editorial / print | Oversized type, ruled masthead       | Full-bleed plate → numbered chapters | You want a distinctive, opinionated, magazine-like look |

All four:

- are dark (`data-theme="dark"`), reuse `FrameworkStrip`, `Reveal` (reduced-motion-aware),
  the shadcn `Button`, and the real Studio screenshots in `src/assets/studio/`;
- typecheck clean and are reachable directly (e.g. `/v1`) — the live home page at `/` is unchanged.

To promote one to the home page, point `src/pages/home/index.tsx` (or the chosen sections)
at the variant's component, or lift individual sections out of `src/pages/variants/*`.
