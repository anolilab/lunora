/**
 * Pulls in the Cloudflare Workers ambient types for everything under `lunora/`,
 * which runs on the Worker rather than in Nitro's Node runtime — most visibly
 * the `cloudflare:email` module the `auth` registry item imports for the
 * `SEND_EMAIL` binding.
 *
 * A triple-slash reference rather than `compilerOptions.types`: that field is an
 * allowlist, so adding it would switch off the automatic inclusion this template
 * relies on, since its root tsconfig is a thin `extends` over the one
 * `nuxt prepare` generates under `.nuxt/`.
 */
/// <reference types="@cloudflare/workers-types" />

export {};
