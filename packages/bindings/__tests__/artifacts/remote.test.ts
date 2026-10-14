import { describe, expect, it } from "vitest";

import { authenticatedRemote } from "../../src/artifacts/remote";

const REMOTE = "https://artifacts.example.test/default/docs.git";

/** Split a built remote into the parts a Git client reads (assertions on parts, not a credential-bearing literal). */
const parts = (url: string): { host: string; password: string; pathname: string; protocol: string; username: string } => {
    const { host, password, pathname, protocol, username } = new URL(url);

    return { host, password, pathname, protocol, username };
};

describe(authenticatedRemote, () => {
    it("embeds the token as the URL password under the `x` user", () => {
        expect.assertions(1);

        expect(parts(authenticatedRemote(REMOTE, "art_v1_abc"))).toStrictEqual({
            host: "artifacts.example.test",
            password: "art_v1_abc",
            pathname: "/default/docs.git",
            protocol: "https:",
            username: "x",
        });
    });

    it("strips the ?expires= suffix from the token", () => {
        expect.assertions(2);

        const built = authenticatedRemote(REMOTE, "art_v1_abc?expires=1790000000");

        expect(parts(built).password).toBe("art_v1_abc");
        expect(built).not.toContain("expires");
    });

    it("percent-encodes characters a userinfo component cannot carry", () => {
        expect.assertions(2);

        const built = parts(authenticatedRemote(REMOTE, "a/b@c"));

        expect(built.password).toBe("a%2Fb%40c");
        expect(decodeURIComponent(built.password)).toBe("a/b@c");
    });

    it("rejects an empty token without quoting it", () => {
        expect.assertions(1);

        expect(() => authenticatedRemote(REMOTE, "?expires=1")).toThrow(/non-empty token/);
    });

    it("rejects a non-https or relative remote, never echoing the token", () => {
        expect.assertions(4);

        const leak = (run: () => string): string => {
            try {
                run();
            } catch (error: unknown) {
                return (error as Error).message;
            }

            return "";
        };

        const http = leak(() => authenticatedRemote("http://artifacts.example.test/r.git", "art_secret"));
        const relative = leak(() => authenticatedRemote("/default/r.git", "art_secret"));

        expect(http).toMatch(/https remote/);
        expect(http).not.toContain("art_secret");
        expect(relative).toMatch(/absolute `remote` URL/);
        expect(relative).not.toContain("art_secret");
    });
});
