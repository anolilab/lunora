# Plan 043: Cloudflare Pages → (reframed) Workers Static Assets

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 388a6423..HEAD -- packages/config/src/wrangler-validator.ts packages/vite/src`. Confirm `WranglerConfig` (`:65-83`) still has no `assets` key and the framework-compose plugin still builds the worker entry as cited below. On mismatch, STOP.

## Status

- **Priority**: P3 — Pages itself is a non-goal; the _reframed_ Workers Static Assets support is a small ergonomics win, not core.
- **Effort**: S (validator + doc note); Pages itself: 0 (rejected).
- **Risk**: LOW — validation/doc only; no runtime change.
- **Depends on**: none
- **Category**: non-goal (Pages) + small config-flag (Static Assets)
- **Planned at**: commit `HEAD`, 2026-06-15

## Verdict

**Cloudflare Pages: REJECTED / non-goal. Do `assets` (Workers Static Assets) instead — and only lightly.** Pages is a separate deploy product that Cloudflare itself now positions behind Workers; for a Vite/Workers-first framework like Lunora it is moot — there is no reason to build a Pages deploy path when the worker already _is_ the deploy unit. The modern, correct way to serve the Vite build alongside the Lunora worker is **Workers Static Assets**: an `"assets": { "directory": "./dist/client", "binding": "ASSETS" }` block in `wrangler.jsonc`, where Cloudflare serves static files for free and only invokes the Worker on misses (so the SSR/API fetch handler still runs). Lunora's framework-compose plugin already produces a single composed Worker fetch handler (`packages/vite/src/framework-compose-plugin.ts`), so static assets layer in _underneath_ it with no entry changes. The work is therefore: (1) write down that Pages is a non-goal, and (2) teach the validator to recognize/shape-check the `assets` block (typo-safety), plus a doc note on the conventional directory/binding. Do **not** auto-inject `assets` — directory layout varies per framework adapter.

## Current state

- **No Pages code, correctly**: `grep -rn "pages_build_output\|cloudflare.?pages\|@cloudflare/pages" packages/` → nothing. Lunora is Workers-first; Pages was never wired.
- **The worker is composed at build time**: `packages/vite/src/framework-compose-plugin.ts` builds a single Worker entry source (`buildWorkerEntrySource`, `:116`; `LUNORA_WORKER_VIRTUAL_ID` / exports at `:212`) that composes the framework SSR handler (React Router `virtual:react-router/server-build` at `:56-59`, SolidStart/TanStack handlers in the same switch) with the Lunora runtime. This is the unit that gets deployed — there is no second "Pages" artifact, which is exactly why Pages is redundant.
- **`assets` is NOT a known validator key**: `packages/config/src/wrangler-validator.ts` `WranglerConfig` (`:65-83`) lists DO/D1/R2/Vectorize/containers/workflows/tail*consumers/observability/migrations/compatibility*\* — no `assets`. So a Static-Assets block today is unvalidated: a typo'd `"diretory"` or a missing `directory` is silently dropped by wrangler with no Lunora warning.
- **The Vite build output exists to be served**: the client build (`dist/client`-style output, per framework adapter) is produced by the framework's Vite build; pointing `assets.directory` at it is the only wiring needed. There is no Lunora abstraction over it today.

What's missing: an explicit "Pages is a non-goal" statement, and `assets` is not a typed/validated key (so Static-Assets misconfig is silent).

## Item breakdown

- [x] **Item 1: Document Pages as a non-goal; point users to Workers Static Assets.**
    - Short docs note: Lunora does not and will not ship a Cloudflare Pages deploy path — the Lunora worker is the deploy unit. To serve the Vite build from the same Worker, use Workers Static Assets (`assets` block). Link CF Static Assets docs.
    - Revisit trigger: Cloudflare deprecates or materially changes Workers Static Assets such that Pages becomes the only path again (unlikely). No code.

- [x] **Item 2: Recognize and shape-check the `assets` block in the validator.**
    - In `packages/config/src/wrangler-validator.ts`, add to `WranglerConfig` (`:65-83`): `assets?: { binding?: string; directory?: string; html_handling?: string; not_found_handling?: string };`.
    - Add `validateAssets(wrangler, errors, warnings)` (mirror `validateTailConsumers` shape): if `assets !== undefined`, require it to be an object and require a non-empty string `directory` (`'assets must declare a non-empty "directory" pointing at the built client output (e.g. "./dist/client")'`); if `binding` is present it must be a non-empty string; if `html_handling`/`not_found_handling` are present they must be strings. Call it next to the other `validate*` calls (`:395-398`).
    - **FS-aware nicety (optional, in `validateWranglerProject`, `:427-488`)**: the existing container-image existence check already does `existsSync(join(configDirectory, image))`. By the same pattern, if `assets.directory` is set but does not exist _at validation time_, push a **warning** (not error — the dir only exists after a build): `'assets.directory "<dir>" does not exist yet — it is created by the client build; run the build before deploy'`. Keep it a warning to avoid breaking pre-build validation.
    - Tests in `packages/config/__tests__/`: valid `{ assets: { directory: "./dist/client", binding: "ASSETS" } }`; missing `directory` → error; `assets: "x"` (wrong shape) → error; non-string `binding` → error. Plain-Node Vitest; no workerd.
    - Doc note: conventional block is `{ "directory": "./dist/client", "binding": "ASSETS" }`; the worker still runs on asset misses, so the Lunora SSR/API handler is unaffected. Do **not** auto-inject — the directory is framework-adapter-specific.

## Verification

- `pnpm --filter "@lunora/config" run build`
- `pnpm --filter "@lunora/config" run test`
- `pnpm --filter "@lunora/config" run lint:types`
- `pnpm --filter "@lunora/config" run lint:eslint`
- Item 1: n/a — docs only.

## STOP conditions

- If you start building a Cloudflare **Pages** deploy path (`pages_build_output_dir`, `wrangler pages deploy`, Pages Functions), STOP — Pages is an explicit non-goal; the Worker is the deploy unit.
- If you start **auto-injecting** an `assets` block into `wrangler.jsonc`, STOP — the build directory is framework-adapter-specific and must be opt-in.
- If `validateAssets` would error (not warn) on a not-yet-built directory, STOP — that breaks valid pre-build validation flows.
