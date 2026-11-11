import { describe, expect, it } from "vitest";

import { apiKey } from "../src/plugins";
import { resolveSessionIdentity } from "../src/session-identity";
import createMemoryAuth from "./helpers/memory-auth";

/**
 * A presented API key that is not valid must read as an anonymous caller, the same as
 * a bad cookie. better-auth throws for it rather than returning no session, so without
 * the mapping the request would fail with a 500 instead of resolving no identity.
 */

const SECRET = "x".repeat(32);

describe("resolveSessionIdentity with an API key", () => {
    it("resolves an unknown key to no identity instead of throwing", async () => {
        expect.assertions(1);

        const auth = createMemoryAuth({
            baseURL: "https://example.test",
            emailAndPassword: { enabled: true },
            plugins: [apiKey({ enableSessionForAPIKeys: true })],
            rateLimit: { enabled: false },
            secret: SECRET,
        });

        const headers = new Headers({ "x-api-key": "unknown-key-".padEnd(64, "k") });

        await expect(resolveSessionIdentity(auth, headers)).resolves.toBeNull();
    });
});
