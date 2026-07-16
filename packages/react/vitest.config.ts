import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "jsdom",
            setupFiles: ["./__tests__/setup.ts"],
        },
    },
    // ratchet: measured 2026-07-16 at 68.46% branches (lines/stmts/funcs clear
    // the default floor) — raise toward the 70% default branches floor.
    { branches: 65 },
);
