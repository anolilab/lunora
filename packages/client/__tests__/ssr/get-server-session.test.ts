import { describe, expect, it, vi } from "vitest";

import type { AuthLike } from "../../src/ssr/get-server-session";
import { getServerSession } from "../../src/ssr/get-server-session";

const COOKIE_HEADER = "better-auth.session_token=abc123";

describe("getServerSession", () => {
    it("returns null when the auth stub resolves no session (no cookie)", async () => {
        const auth: AuthLike = {
            api: {
                getSession: async () => null,
            },
        };

        const request = new Request("https://app.example.com/", {
            headers: { cookie: "" },
        });

        await expect(getServerSession(request, auth)).resolves.toBeNull();
    });

    it("returns the { user, session } shape when the auth stub resolves a session", async () => {
        const resolved = {
            session: { id: "sess_1", token: "abc123" },
            user: { id: "user_1", name: "Ada" },
        };
        const getSession = vi.fn(async (_input: { headers: Headers }) => resolved);
        const auth: AuthLike<typeof resolved> = { api: { getSession } };

        const request = new Request("https://app.example.com/", {
            headers: { cookie: COOKIE_HEADER },
        });

        const result = await getServerSession(request, auth);

        expect(result).toEqual(resolved);
        // The request's Headers are forwarded verbatim to better-auth.
        expect(getSession).toHaveBeenCalledTimes(1);

        const call = getSession.mock.calls.at(0);

        expect(call?.[0].headers.get("cookie")).toBe(COOKIE_HEADER);
    });

    it("accepts a bare Headers object as the request source", async () => {
        const resolved = { session: { id: "s" }, user: { id: "u" } };
        const auth: AuthLike<typeof resolved> = { api: { getSession: async () => resolved } };

        const headers = new Headers({ cookie: COOKIE_HEADER });

        await expect(getServerSession(headers, auth)).resolves.toEqual(resolved);
    });

    it("accepts a { headers } object and normalises an undefined result to null", async () => {
        const auth: AuthLike<undefined> = {
            api: {
                getSession: () => undefined,
            },
        };

        const result = await getServerSession({ headers: new Headers() }, auth);

        expect(result).toBeNull();
    });
});
