import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * A lower BRANCH floor only — statements/functions/lines meet the repo default.
 *
 * The floor travelled here with the conformance TCK when
 * `@lunora/platform-conformance` folded into `src/conformance/`: that code is
 * test infrastructure, and its unexercised branches are the failure paths a
 * MISBEHAVING host would trip — reachable only by writing hosts that violate
 * the contract in order to measure the kit that catches them. The contracts in
 * `src/*.ts` are types and stay fully covered.
 *
 * A ratchet, not a target: set just under the current measurement (59.7%) so a
 * regression still fails; raise it as real host adapters exercise more of the
 * reference implementation.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 58 });
