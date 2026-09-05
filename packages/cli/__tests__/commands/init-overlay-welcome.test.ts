import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REACT_APP, SOLID_APP, SVELTE_APP, VANILLA_MAIN, VUE_APP } from "../../src/commands/init/overlay/welcome";

// __tests__/commands/ -> package root -> packages/ -> monorepo root -> api-snapshots/
const CLIENT_API_SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "api-snapshots", "client.api.md");

/** Every `client.<name>(` the overlay's scaffolded sources call. */
const clientMethodsCalled = (source: string): ReadonlyArray<string> =>
    [...source.matchAll(/\bclient\.(?<method>[A-Za-z_$][\w$]*)\s*\(/gu)].map((match) => match.groups?.method ?? "");

describe("init overlay welcome sources", () => {
    /**
     * The overlay is scaffolded verbatim into a user's project and is NOT covered
     * by `scripts/template-build-smoke.sh`, which builds `templates/*` — so
     * `client.onUpdate(...)` shipped in the vanilla starter, a method
     * `@lunora/client` has never had. Every `lunora init --vite vanilla` produced
     * a project that failed `tsc` with TS2339 and threw
     * `client.onUpdate is not a function` in the browser.
     *
     * Reads the published client surface rather than importing it: the scaffolded
     * source is a string, so nothing else type-checks these call sites.
     */
    it("only calls LunoraClient methods that exist on the published client surface", () => {
        expect.assertions(1);

        const snapshot = readFileSync(CLIENT_API_SNAPSHOT, "utf8");
        const called = [...new Set([REACT_APP, SOLID_APP, SVELTE_APP, VANILLA_MAIN, VUE_APP].flatMap((source) => clientMethodsCalled(source)))];

        // The class body is `class LunoraClient {` up to the next top-level heading.
        const body = snapshot.slice(snapshot.indexOf("class LunoraClient {")).split("\n### ")[0] ?? "";
        const unknown = called.filter((method) => !new RegExp(String.raw`^\s{4}(?:readonly )?${method}[(<:]`, "mu").test(body));

        expect(unknown).toStrictEqual([]);
    });
});
