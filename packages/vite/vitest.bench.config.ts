import codspeedPlugin from "@codspeed/vitest-plugin";

import { getBenchConfig } from "../../tools/get-bench-config";

// Vite 8 gives this package its own vitest copy; the CodSpeed runner must come
// from here to read the benches registered in it.
export default getBenchConfig({}, codspeedPlugin);
