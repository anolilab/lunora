/**
 * Pulls in the Cloudflare Workers ambient types for everything under `lunora/`,
 * which runs on the Worker rather than in Next's Node/edge runtime — most
 * visibly the `cloudflare:email` module the `auth` registry item imports for the
 * `SEND_EMAIL` binding.
 *
 * A triple-slash reference rather than `compilerOptions.types`: that field is an
 * allowlist, so adding it here would switch off the automatic inclusion Next
 * relies on for `next-env.d.ts`, `@types/react`, and `@types/node`. The other
 * templates can use `types` because nothing in them depends on that automatic
 * inclusion.
 */
/// <reference types="@cloudflare/workers-types" />

export {};
