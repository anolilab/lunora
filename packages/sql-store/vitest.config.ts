import { getVitestConfig } from "../../tools/get-vitest-config";

// Pure-Node suite: the SQL store core is dialect-parameterized logic over an
// injected SqlExec, so the unit tests feed plain-object exec/dialect doubles
// (and a node:sqlite-backed exec) and never need workerd.
export default getVitestConfig({ test: { environment: "node" } });
