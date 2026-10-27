import { getVitestConfig } from "../../tools/get-vitest-config";

// The Access integration is verification logic over `jose` (JWKS fetch + RS256
// verify) plus a `resolveIdentity` adapter — pure functions tested in plain
// Node against locally-minted RS256 tokens and structural `Request` doubles.
// No workerd pool needed.
export default getVitestConfig({ test: { environment: "node" } });
