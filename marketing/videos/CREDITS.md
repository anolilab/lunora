# Credits — Lunora marketing videos

Asset layout:

- **`public/`** is bundled into every render — keep it lean (only shipped assets).
- **`sources/`** holds raw inputs (full tracks, synth output) that are **not**
  bundled. Trim/copy from here into `public/` to ship.

## Music

- **`public/audio/launch-theme.mp3`** — what the launch video plays: a ~33s
  high-energy section trimmed (with fades) from the source below via
  `scripts/cut-audio.sh`.
- **`sources/audio/launch-theme-source.mp3`** — the raw source: a Pixabay track
  by **audioknap** (Pixabay Content License — free for commercial use, **no
  attribution required**). Source page: https://pixabay.com/music/458044/
- **`sources/audio/synth-fallback.wav`** — an original, CC0 track synthesized
  in-repo (`scripts/gen-music.mjs`). A fully rights-clean fallback; not shipped.

The cut grid is locked to the track's **kick pulse ≈121.75 BPM** (set in
`src/launch/timings.ts`) so every scene boundary and word-flash lands on the
beat you hear.

## Sound effects

Original, CC0, synthesized in-repo. Played via core `remotion` `<Audio>` (its
lenient PCM playback handles short mono WAVs that `@remotion/media`'s strict
parser drops). The bed ducks under these moments (see `themeVolume` in
`launch/composition.tsx`).

- **`public/audio/sfx-message-ping.wav`** — message send/receive ping (reactive
  scene).
- **`public/audio/sfx-key.wav`** — a key-tick played once per character, synced
  to the text typing out (terminal command + chat composer). From Kenney's
  "Interface Sounds" pack (`tick_002`, **CC0 / public domain** — no attribution
  required), via the soundcn library; converted to mono PCM WAV.

## Visuals

- Backgrounds are pure CSS (see `src/shared/background.tsx`) — no image assets.
- **`public/brand/lunora.svg`** — Lunora's own logo.
- **`public/brand/cloudflare.svg`** — official Cloudflare brand glyph (from
  simple-icons), shown as a "Built for Cloudflare" attribution. Cloudflare is a
  trademark of Cloudflare, Inc.; replace this file with the asset from
  Cloudflare's brand kit if you need the exact current mark.
- **Fonts** — Geist Sans / Geist Mono (via `@remotion/google-fonts`).

## Adding a new video

1. Scenes/composition under `src/<video>/`.
2. Per-video soundtrack → `public/audio/<video>-theme.mp3` (trim its raw source
   from `sources/audio/` with `scripts/cut-audio.sh`).
3. Reuse shared assets in `public/audio/sfx-*` and `public/brand/*`.
