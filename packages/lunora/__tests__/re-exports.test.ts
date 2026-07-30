import { describe, expect, it } from "vitest";

const sorted = (keys: ReadonlyArray<string>): ReadonlyArray<string> => [...keys].toSorted((a, b) => a.localeCompare(b));

// The umbrella is a pure re-export surface: each subpath must forward the
// upstream package's public API unchanged. These smoke tests guard against a
// subpath silently dropping its barrel (e.g. a typo in `export *`) or the
// export map drifting from the underlying package's surface.

// [umbrella specifier, upstream specifier]. The default entry (`lunorash`)
// mirrors `@lunora/server`; every other subpath forwards its namesake.
const reExports: ReadonlyArray<readonly [string, string]> = [
    ["lunorash", "@lunora/server"],
    ["lunorash/server", "@lunora/server"],
    ["lunorash/server/types", "@lunora/server/types"],
    ["lunorash/server/data-model", "@lunora/server/data-model"],
    ["lunorash/server/drizzle", "@lunora/server/drizzle"],
    ["lunorash/server/rls/testing", "@lunora/server/rls/testing"],
    ["lunorash/values", "@lunora/values"],
    ["lunorash/runtime", "@lunora/runtime"],
    ["lunorash/do", "@lunora/do"],
    ["lunorash/platform", "@lunora/platform"],
    ["lunorash/client", "@lunora/client"],
    ["lunorash/client/query", "@lunora/client/query"],
    ["lunorash/client/auth", "@lunora/client/auth"],
    ["lunorash/client/pagination", "@lunora/client/pagination"],
    ["lunorash/client/ssr", "@lunora/client/ssr"],
    ["lunorash/errors", "@lunora/errors"],
    ["lunorash/ratelimit", "@lunora/ratelimit"],
    ["lunorash/flags", "@lunora/flags"],
    // The flags providers are re-exported under a flattened alias: the umbrella
    // exposes `lunorash/flags/<provider>` for `@lunora/flags/providers/<provider>`.
    ["lunorash/flags/env", "@lunora/flags/providers/env"],
    ["lunorash/flags/flagship", "@lunora/flags/providers/flagship"],
    ["lunorash/flags/memory", "@lunora/flags/providers/memory"],
    ["lunorash/flags/web", "@lunora/flags/web"],
];

describe("lunora umbrella re-exports", () => {
    it.each(reExports)("forwards %s from %s", async (umbrella, upstream) => {
        expect.assertions(1);

        const viaUmbrella = await import(umbrella);
        const direct = await import(upstream);

        expect(sorted(Object.keys(viaUmbrella))).toStrictEqual(sorted(Object.keys(direct)));
    });
});
