import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * A lower BRANCH floor only — statements/functions/lines stay at the default and
 * pass at ~85%.
 *
 * This package's `src` is test infrastructure: a reference in-memory host and
 * the parameterized suite that asserts the host contract. Its unexercised
 * branches are the failure paths a *misbehaving* host would trip, which only a
 * deliberately broken host reaches — so driving them to 70% would mean writing
 * hosts that violate the contract in order to measure the kit that catches them.
 *
 * A ratchet, not a target: raise it as real host adapters land and exercise more
 * of the reference implementation.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 55 });
