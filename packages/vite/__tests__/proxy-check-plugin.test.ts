import { describe, expect, it } from "vitest";

import { checkLunoraProxy } from "../src/proxy-check-plugin";

/**
 * Both misconfigurations this guards against fail identically and silently: the app
 * loads, HTTP RPC answers, and the live query never arrives — so the UI sits on its
 * loading state with nothing in the console.
 */
describe("checkLunoraProxy", () => {
    it("returns nothing when there is no proxy table", () => {
        expect.assertions(1);

        expect(checkLunoraProxy(undefined, "server")).toStrictEqual([]);
    });

    it("ignores proxy entries that do not route a Lunora path", () => {
        expect.assertions(1);

        expect(checkLunoraProxy({ "/api": { target: "http://localhost:8787", ws: false } }, "server")).toStrictEqual([]);
    });

    it("accepts a correctly configured entry", () => {
        expect.assertions(1);

        expect(checkLunoraProxy({ "/_lunora": { target: "http://localhost:8787", ws: true } }, "server")).toStrictEqual([]);
    });

    it("flags the string shorthand, which cannot express ws at all", () => {
        expect.assertions(3);

        const [warning, ...rest] = checkLunoraProxy({ "/_lunora": "http://localhost:8787" }, "server");

        expect(warning).toContain("string shorthand");
        // The remedy names the object form with the same target, so it is copy-pasteable.
        expect(warning).toContain('{ target: "http://localhost:8787", ws: true }');
        expect(rest).toStrictEqual([]);
    });

    it("flags the object form when ws is missing or false", () => {
        expect.assertions(2);

        expect(checkLunoraProxy({ "/_lunora": { target: "http://localhost:8787" } }, "server")[0]).toContain("missing `ws: true`");
        expect(checkLunoraProxy({ "/_lunora": { target: "http://localhost:8787", ws: false } }, "server")[0]).toContain("missing `ws: true`");
    });

    it("flags changeOrigin, which trips the CSRF origin guard off loopback", () => {
        expect.assertions(2);

        const warnings = checkLunoraProxy({ "/_lunora": { changeOrigin: true, target: "http://localhost:8787", ws: true } }, "server");

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("trustedOrigins");
    });

    it("reports both problems on one entry", () => {
        expect.assertions(1);

        expect(checkLunoraProxy({ "/_lunora": { changeOrigin: true, target: "http://localhost:8787" } }, "server")).toHaveLength(2);
    });

    it("matches a more specific path and labels the table it came from", () => {
        expect.assertions(2);

        const warnings = checkLunoraProxy({ "/_lunora/ws": { target: "http://localhost:8787" } }, "preview");

        expect(warnings[0]).toContain('preview.proxy["/_lunora/ws"]');
        // A prefix shorter than the marker (e.g. `/_`) still routes Lunora traffic.
        expect(checkLunoraProxy({ "/_": { target: "http://localhost:8787" } }, "server")).toHaveLength(1);
    });
});
