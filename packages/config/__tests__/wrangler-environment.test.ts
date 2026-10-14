import { describe, expect, it } from "vitest";

import type { WranglerConfig } from "../src/cloudflare/wrangler-config";
import { mergeWranglerEnvironment, NON_INHERITABLE_KEYS } from "../src/cloudflare/wrangler-environment";

/**
 * Wrangler does not fall back to the top level for a non-inheritable key: a
 * declared environment that omits it simply has none. The merge has to model
 * that for every key in the table (`analytics` and `k2` included), and an env
 * that overrides one is a known rule, not an "unverified" key.
 */
describe(mergeWranglerEnvironment, () => {
    it.each(NON_INHERITABLE_KEYS)("does not inherit a top-level %s into a declared env", (key) => {
        expect.assertions(2);

        const wrangler = { env: { production: {} }, [key]: { marker: `top-level ${key}` } } as unknown as WranglerConfig;
        const { merged, unverifiedKeys } = mergeWranglerEnvironment(wrangler, "production");

        expect(merged[key]).toBeUndefined();
        expect(unverifiedKeys).toStrictEqual([]);
    });

    it.each(NON_INHERITABLE_KEYS)("uses an env's own %s without an unverified warning", (key) => {
        expect.assertions(2);

        const own = { marker: `production ${key}` };
        const wrangler = { env: { production: { [key]: own } }, [key]: { marker: `top-level ${key}` } } as unknown as WranglerConfig;
        const { merged, unverifiedKeys } = mergeWranglerEnvironment(wrangler, "production");

        expect(merged[key]).toBe(own);
        expect(unverifiedKeys).toStrictEqual([]);
    });
});
