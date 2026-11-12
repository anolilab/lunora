# Plan 555 — Reconcile dependency versions pinned differently across pnpm catalogs

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — each real split is a dependency decision)
**Priority / effort / risk:** P3 / S / LOW. **Category:** deps.

## 0. Headline finding

23 packages appear in more than one named catalog of `pnpm-workspace.yaml` with different specifiers.
`scripts/check-catalog-drift.js` guards only manifests that bypass catalogs with literal versions; it
does not compare catalogs with each other, so two catalogs can drift silently.

## 1. Current state — the 23, split into three kinds

Derived by parsing every catalog in `pnpm-workspace.yaml` at the baseline:

- **Range vs the same exact version** (cosmetic, same resolution today; pick one style):
  `@tailwindcss/vite` (vite `^4.3.3` / web `4.3.3`), `tailwindcss` (same), `@testing-library/jest-dom`,
  `@testing-library/react`, `@types/react`, `@types/react-dom`, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `react`, `react-dom`, `eslint-plugin-react-compiler`, `eslint-plugin-react-hooks`
  (lint `7.1.1` / web `^7.1.1`), `jiti` (tooling `^2.7.0` / cli `2.7.0`).
- **Real version splits** (different resolved versions):
  `vite` (vite `^8.3.5` / web `8.3.2`), `motion` (frontend `^14.9.0` / web `14.0.0`),
  `@babel/core` (build `^8.1.0` / web `8.0.6`), `@tanstack/react-router` (`^1.170.46` / `1.170.41`),
  `@tanstack/react-start` (`^1.169.4` / `1.168.60`), `@tanstack/react-virtual` (`^3.14.25` / `3.14.13`).
- **Deliberate** (Solid 2 track): `solid-js` (frontend `^1.9.18` / solid2 `2.0.0-rc.0`),
  `vite-plugin-solid`, `@solidjs/testing-library`.

## 4. Design decisions

- For each real split: bump the lagging catalog to the leading version, or document why the `web`
  catalog pins lower (e.g. the docs site pinned exact on purpose).
- Extend `scripts/check-catalog-drift.js` (or a sibling) to fail when one package appears in two
  catalogs with different specifiers, with an explicit allowlist for the deliberate `solid2` entries
  (each with a reason).

## 5. Workstreams

1. (S) Real splits: one change per family (vite, motion, babel, tanstack), `pnpm install`, the affected
   apps' builds and tests.
2. (S) Cosmetic: align specifier style per the catalog's convention.
3. (S) The cross-catalog guard, wired into the `dependency-manifests` job in `lint.yml` and
   `lint:catalog-drift`; prove it goes red by reintroducing one split.

## 6. Platform parity

Not applicable.

## 7. Gates

`pnpm run lint:catalog-drift` green; affected app builds green; the guard red on a planted split.

## 8. Risks

- **Risk:** the `web` catalog's exact pins may protect the docs site from a known regression; check
  `git log -S` on each pin before bumping.
- Never text-merge `pnpm-lock.yaml`; regenerate it.

## 9. Open questions

1. Is `web` meant to pin exact versions as policy?
