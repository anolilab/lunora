import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

describe("artifacts types in an app without disposable typings", () => {
    it("type-check repo calls under lib ES2024 + workers-types, without node types", () => {
        expect.assertions(1);

        // `consumer-types/tsconfig.json` is the app setup; a collapsed repo client
        // shows up as TS2339 / TS18048 / TS2554 on the calls in `consumer.ts`.
        const result = spawnSync(process.execPath, [tsc, "-p", join(here, "consumer-types")], { encoding: "utf8" });

        expect({ output: result.stdout + result.stderr, status: result.status }).toStrictEqual({ output: "", status: 0 });
    }, 60_000);
});
