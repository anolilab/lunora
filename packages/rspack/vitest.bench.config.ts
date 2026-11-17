import codspeedPlugin from "@codspeed/vitest-plugin";

import { getBenchConfig } from "../../tools/get-bench-config";

// This package resolves the Vite 8 vitest copy; the CodSpeed runner must come
// from here to read the benches registered in it.
export default getBenchConfig({}, codspeedPlugin);
