# Lunora marketing videos

[Remotion](https://www.remotion.dev/) project holding every Lunora launch and
release video as a separate composition, built on the
[remocn](https://remocn.dev) shadcn registry of Remotion components. Run
`pnpm dev` and pick a composition from the Studio sidebar.

## Compositions

| ID             | Video                          |
| -------------- | ------------------------------ |
| `LunoraLaunch` | v1.0-alpha launch (~35s, 16:9) |

## Layout

- `src/shared/` — pieces shared across videos: `Background` (remocn mesh
  gradient in brand colors + vignette/grain), `Outro`, `Stage` (enter/exit
  wrapper), `SceneLabel`, `LunoraMark`, `theme.ts` (brand tokens + copy),
  `fonts.ts` (Geist + the `--font-geist-*` CSS vars remocn expects).
- `src/launch/` — the launch video: `composition.tsx` sequences the scenes,
  `timings.ts` derives each scene's `from` from one duration list, `code.ts`
  holds the on-screen snippets, and `*-scene.tsx` are the individual beats
  (intro → install → schema → functions → reactive → scale → outro).
- `src/components/remocn/` + `src/lib/remocn-ui/` — components vendored from the
  remocn registry (we own the code). A few were lightly adapted: the text
  components (`blur-reveal`, `tracking-in`, `typewriter`) take a `background`
  prop (default transparent) so they layer over the shared backdrop,
  `blur-reveal` reveals over an explicit `revealFrames` (the upstream default
  keyed off the whole composition length, which misbehaves nested in a
  `Sequence`), and `terminal-simulator`'s outer backdrop is transparent.
- `src/root.tsx` — registers every composition.

## Brand

The mark geometry is the official logo (`.github/assets/lunora.svg`, mirrored to
`public/brand/lunora.svg`), filled with the favicon's red→purple→blue gradient (frozen
static — SMIL renders non-deterministically headless). Tokens live in
`src/shared/theme.ts`.

## Commands

```bash
pnpm dev                  # Remotion Studio (preview / scrub)
pnpm render:launch        # render LunoraLaunch → out/lunora-launch.mp4
pnpm render <id> out/x.mp4 # render any composition
pnpm lint:types           # tsc --noEmit
```

## Adding a remocn component

```bash
pnpm ui:add @remocn/<name>   # e.g. pnpm ui:add @remocn/code-diff-wipe
```

Components land in `src/components/remocn/` (configured in `components.json`).
Browse the catalog at [remocn.dev](https://remocn.dev). Remember the `@/*` alias
is mirrored into the Remotion webpack config (`remotion.config.ts`) because the
bundler doesn't read `tsconfig` paths.

## Adding a new release video

1. `cp -r src/launch src/v1-1` (or scaffold fresh scenes).
2. Adjust `timings.ts` durations and the scene set in `composition.tsx`.
3. Register it in `src/root.tsx` with a new `id`.
