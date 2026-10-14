import { getVitestConfig } from "../../tools/get-vitest-config";

// Pure-Node suite: the Hyperdrive client is driver-agnostic plumbing over a
// connection string, so the unit tests feed plain-object binding/driver doubles
// and never need workerd. Any real-binding test is CI-only (see __tests__).
//
// ratchet: functions below the default floor (the mysql-memory-server suite is
// skipped where the binary is unobtainable); raise as coverage improves.
export default getVitestConfig({ test: { environment: "node" } }, { functions: 70 });
