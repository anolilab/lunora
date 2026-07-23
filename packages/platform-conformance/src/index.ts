/**
 * `@lunora/platform-conformance` — behavioral TCK for Lunora platform hosts.
 *
 * Exports a parameterized Vitest suite that asserts the provider-neutral host
 * contract from `@lunora/platform`, plus a reference in-memory host factory
 * built on `node:sqlite`.
 */

export type { ConformanceHost, ConformanceHostFactory, ReferenceHost } from "./reference-host";
export { createReferenceHost } from "./reference-host";
export type { VitestApi } from "./suite";
export { defineHostContractSuite } from "./suite";
