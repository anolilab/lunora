/**
 * `@lunora/config/studio-host` — internal, build-time-shared helpers for hosting
 * the prebuilt `@lunora/studio` SPA during local dev.
 *
 * Three dev hosts serve the studio from this code, so it behaves identically
 * regardless of how the project is run:
 * - `@lunora/vite` and `@lunora/rspack` mount `createStudioMiddleware` on their
 * dev server at `/__lunora` — same routing, same URL.
 * - `@lunora/cli` (`lunora dev`) serves it from a standalone Node HTTP server
 * with its own routing (a root mount, and a read-only shell off loopback).
 *
 * The genuinely shared parts live here: render the host HTML with per-server
 * config injected, resolve the admin token the same way the worker does, gate
 * the transport, and load the prebuilt asset bytes.
 */
export { parseDevVariable, resolveAdminToken } from "./admin-token";
export { applyStudioAssetCache, sendStudioDocument } from "./asset-cache";
export { assetContentType, isStandaloneModulePath, loadStudioAssets, readStandaloneAsset, resolveStandaloneDirectory, studioAssetsStamp } from "./assets";
export type { StudioMiddlewareOptions } from "./middleware";
export { createStudioMiddleware, isNonLoopbackHost, STUDIO_PATH, STUDIO_SCRIPT_PATH, STUDIO_STYLE_PATH, studioMountPath } from "./middleware";
export type { PolicyScaffoldBody, PolicyScaffoldRequest, PolicyScaffoldResponse, WirePolicyEdit } from "./policy-scaffold-handler";
export { handlePolicyScaffoldRequest, POLICY_SCAFFOLD_ENDPOINT } from "./policy-scaffold-handler";
export { default as renderStudioHtml } from "./render-html";
export type { SchemaEditRequest, SchemaEditResponse } from "./schema-edit-handler";
export { handleSchemaEditRequest, SCHEMA_EDIT_ENDPOINT } from "./schema-edit-handler";
export type { SeedRequest, SeedRequestBody, SeedResponse } from "./seed-handler";
export { handleSeedRequest, SEED_ENDPOINT } from "./seed-handler";
export type { LocalEndpointContext, LocalEndpointHandler, LocalEndpointRequest, LocalEndpointResponse } from "./serve-json-handler";
// `serveJsonHandler` applies the shared CSRF gate itself, so a host gets that
// defense by routing through it — no per-host copy of the check to drift.
export { serveJsonHandler } from "./serve-json-handler";
export { ALLOW_FORWARDED_ENV, headerValue, isLoopbackAddress, transportRejectionReason } from "./transport-guard";
export type { StudioAssets, StudioHtmlConfig, WarnLogger } from "./types";
