# Lunora marketing

The marketing assets that live in the product repo — the brand guide, the design
tokens, and the launch video.

> **Launch copy + the marketing plan live in a separate private repo:**
> [`anolilab/lunora-marketing`](https://github.com/anolilab/lunora-marketing). They're
> kept out of this open repo so the launch lands as a surprise. The `social/` copy
> references the assets below by path.

> Voice (from [`BRAND.md`](./BRAND.md)): direct, technical, no hype, no
> superlatives, honest about alpha, show-don't-tell. Lowercase `lunora`.
> Aurora-ribbon accent (cyan → violet → rose, violet primary) used sparingly —
> never Cloudflare orange.
>
> Launch framing: **first public release of an open alpha — "try it on a side
> project, shape v1."** Never "production-ready."

## Folders

| Folder                               | What's in it                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`BRAND.md`](./BRAND.md)             | Brand guide — the moon mark, Luna+Aurora palette, voice, canonical copy, and the Cloud brand stance.                                                                         |
| [`videos/`](./videos/)               | Remotion project for launch/release videos. `out/lunora-launch.mp4` is the ~35s launch sizzle — the hero asset for the launch. See [`videos/README.md`](./videos/README.md). |
| [`design-tokens/`](./design-tokens/) | Brand design tokens (`tokens.css`, `tokens.ts`) and [`DESIGN.md`](./design-tokens/DESIGN.md). **Imported by the docs site + Studio** — these stay in the monorepo.           |

The post drafts, the launch checklist, and the full marketing plan are in the private
[`anolilab/lunora-marketing`](https://github.com/anolilab/lunora-marketing) repo.

## Lunora Cloud (planned)

The OSS framework funnels a planned managed **Lunora Cloud** (the business). From
day one, the docs site carries a one-field **"Lunora Cloud — early access"** waitlist
beside the "try the OSS" CTA — a qualified waitlist is the most valuable thing to
collect pre-cloud. Brand stance (one brand; ink mark = OSS, aurora mark = Cloud; the
paid tier still runs on the customer's own Cloudflare account) lives in
[`BRAND.md`](./BRAND.md#lunora-cloud-planned). Don't build cloud landing/pricing brand
until the product exists.
