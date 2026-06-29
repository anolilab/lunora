/**
 * `@lunora/flags`
 *
 * OpenFeature-based feature flags for Lunora. `defineFlags` in `lunora/flags.ts`
 * configures an OpenFeature provider (Cloudflare Flagship by default, any
 * provider pluggable); codegen wires `ctx.flags` onto every handler ctx from it.
 *
 * - `@lunora/flags` — `defineFlags`, the `createFlags` ctx facade, and types.
 * - `@lunora/flags/providers/flagship` — the first-class Cloudflare Flagship provider.
 * - `@lunora/flags/providers/memory` — a static, in-memory provider (tests/local/simple apps, zero extra deps).
 * - `@lunora/flags/providers/env` — reads flags from the Worker `env` vars/secrets (zero deps).
 * - `@lunora/flags/web` — optional browser OpenFeature provider (escape hatch).
 * @packageDocumentation
 */
export { defineFlags, isFlagsDefinition } from "./define-flags";
export type { CreateFlagsOptions } from "./flags";
export { createFlags } from "./flags";
export type { FlagsAuth, FlagsConfig, FlagsDefinition, FlagsProviderFactory, LunoraFlags } from "./types";

// Re-export the OpenFeature types an app touches when authoring `defineFlags` or
// reading evaluation details, so consumers don't need a direct dependency on
// `@openfeature/server-sdk` just for typing.
export type { EvaluationContext, EvaluationDetails, Hook, JsonValue, Logger, Provider } from "@openfeature/server-sdk";
