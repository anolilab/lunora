import { getVitestConfig } from "../../tools/get-vitest-config";

// `@lunora/flags` is a thin facade over an OpenFeature provider — `createFlags`
// drives the provider's `resolve*Evaluation` methods through the OpenFeature
// client, the Flagship provider wraps `@cloudflare/flagship`. Everything is
// tested in plain Node against structural provider fakes; no workerd pool is
// needed. Tests live under `__tests__/` and match vitest's default `*.test.ts`.
export default getVitestConfig({ test: { environment: "node" } });
