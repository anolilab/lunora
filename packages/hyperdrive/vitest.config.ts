import { getVitestConfig } from "../../tools/get-vitest-config";

// Pure-Node suite: the Hyperdrive client is driver-agnostic plumbing over a
// connection string, so the unit tests feed plain-object binding/driver doubles
// and never need workerd. Any real-binding test is CI-only (see __tests__).
//
// ratchet: measured 2026-07-16 at 73.52% funcs (83.8% lines, 81.8% branches;
// mysql-memory-server suite excluded in the sandbox) — raise toward the 80%
// default functions floor.
export default getVitestConfig({ test: { environment: "node" } }, { functions: 70 });
