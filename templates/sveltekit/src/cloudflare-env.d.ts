/**
 * Pulls in the Cloudflare Workers ambient types for everything under `lunora/`,
 * which runs on the Worker rather than in SvelteKit's Node runtime — most
 * visibly the `cloudflare:email` module the `auth` registry item imports for the
 * `SEND_EMAIL` binding.
 *
 * A triple-slash reference rather than `compilerOptions.types`: that field is an
 * allowlist, so adding it would switch off the automatic inclusion this template
 * relies on, since its root tsconfig is a thin `extends` over the one
 * `svelte-kit sync` generates under `.svelte-kit/`.
 *
 * Under `src/` rather than the project root because the root tsconfig's
 * `include` is `["src/**\/*", "lunora/**\/*"]` — a root-level file would not be
 * part of the program at all.
 */
/// <reference types="@cloudflare/workers-types" />

export {};
