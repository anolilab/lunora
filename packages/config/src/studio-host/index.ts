/**
 * `@cirrus/config/studio-host` — internal, build-time-shared helpers for hosting
 * the prebuilt `@cirrus/studio` SPA during local dev.
 *
 * Two surfaces inline this code so the dev studio behaves identically
 * regardless of how the project is run:
 * - `@cirrus/vite` serves the studio from a Vite middleware at `/__cirrus`.
 * - `@cirrus/cli` (`cirrus dev`) serves it from a standalone Node HTTP server.
 *
 * Each owns its own transport (Connect middleware vs `node:http`) and routing;
 * the genuinely shared parts live here: render the host HTML with per-server
 * config injected, resolve the admin token the same way the worker does, and
 * load the prebuilt asset bytes.
 */
export { parseDevVariable, resolveAdminToken } from "./admin-token";
export { default as loadStudioAssets, studioAssetsStamp } from "./assets";
export type { PolicyScaffoldBody, PolicyScaffoldRequest, PolicyScaffoldResponse, WirePolicyEdit } from "./policy-scaffold-handler";
export { handlePolicyScaffoldRequest, POLICY_SCAFFOLD_ENDPOINT } from "./policy-scaffold-handler";
export { default as renderStudioHtml } from "./render-html";
export type { SchemaEditRequest, SchemaEditResponse } from "./schema-edit-handler";
export { handleSchemaEditRequest, SCHEMA_EDIT_ENDPOINT } from "./schema-edit-handler";
export type { StudioAssets, StudioHtmlConfig, WarnLogger } from "./types";
