import { describe, expect, it } from "vitest";

import { INTERNAL_SECRET_HEADER } from "../src/auth-do";
import type { AuthNamespaceLike } from "../src/do-wiring";
import { createDoAuthWiring } from "../src/do-wiring";

/**
 * The worker-side wiring for DO-backed auth.
 *
 * This logic used to live in a codegen template string, where it could only ever be
 * typechecked — a wrong header name or a mis-built URL would have compiled and failed
 * in production. These are the assertions that were impossible to write before.
 */

const SECRET = "wiring-internal-secret"; // secret-scanner:allow

/** A namespace double recording the requests its stub receives. */
const createNamespace = (respond: (request: Request) => Response): { names: string[]; namespace: AuthNamespaceLike; requests: Request[] } => {
    const requests: Request[] = [];
    const names: string[] = [];

    return {
        names,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        requests.push(request);

                        return respond(request);
                    },
                };
            },
            idFromName: (name: string) => {
                names.push(name);

                return name;
            },
        },
        requests,
    };
};

const ok = (body: unknown): Response => Response.json(body);

describe("createDoAuthWiring", () => {
    describe("authHandler", () => {
        it("forwards an auth route to the object", async () => {
            expect.assertions(2);

            const { namespace, requests } = createNamespace(() => new Response("served"));
            const { authHandler } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            const response = await authHandler(new Request("https://example.test/api/auth/sign-in/email", { method: "POST" }));

            await expect(response?.text()).resolves.toBe("served");
            expect(requests).toHaveLength(1);
        });

        it("leaves a non-auth route alone, so the Lunora worker still handles it", async () => {
            expect.assertions(2);

            const { namespace, requests } = createNamespace(() => new Response("served"));
            const { authHandler } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            // Returning a Response here would swallow every request in the app.
            await expect(authHandler(new Request("https://example.test/documents/list"))).resolves.toBeUndefined();
            expect(requests).toHaveLength(0);
        });

        it("honours a custom base path", async () => {
            expect.assertions(2);

            const { namespace } = createNamespace(() => new Response("served"));
            const { authHandler } = createDoAuthWiring({ basePath: "/auth", internalSecret: SECRET, namespace });

            await expect(authHandler(new Request("https://example.test/auth/sign-in/email"))).resolves.toBeDefined();
            await expect(authHandler(new Request("https://example.test/api/auth/sign-in/email"))).resolves.toBeUndefined();
        });

        it("reports no response when the namespace binding is absent", async () => {
            expect.assertions(1);

            const { authHandler } = createDoAuthWiring({ internalSecret: SECRET, namespace: undefined });

            // A missing binding must read as "auth not configured", not a TypeError
            // thrown mid-request.
            await expect(authHandler(new Request("https://example.test/api/auth/get-session"))).resolves.toBeUndefined();
        });
    });

    describe("resolveIdentity", () => {
        it("returns the user id the object reports", async () => {
            expect.assertions(1);

            const { namespace } = createNamespace(() => ok({ userId: "user_123" }));
            const { resolveIdentity } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            await expect(resolveIdentity(new Request("https://example.test/documents/list"))).resolves.toStrictEqual({ userId: "user_123" });
        });

        it("sends the secret and forwards the caller's cookie", async () => {
            expect.assertions(3);

            const { namespace, requests } = createNamespace(() => ok({ userId: "user_123" }));
            const { resolveIdentity } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            await resolveIdentity(new Request("https://example.test/documents/list", { headers: { cookie: "better-auth.session_token=abc" } }));

            const [forwarded] = requests;

            // The cookie is what the object needs to identify the session; the secret is
            // what authorises asking. Both, or the route is useless.
            expect(forwarded?.headers.get(INTERNAL_SECRET_HEADER)).toBe(SECRET);
            expect(forwarded?.headers.get("cookie")).toBe("better-auth.session_token=abc");
            expect(new URL(forwarded?.url ?? "").pathname).toBe("/__lunora/auth/session");
        });

        it("treats an anonymous reply as anonymous", async () => {
            expect.assertions(1);

            const { namespace } = createNamespace(() => ok({}));
            const { resolveIdentity } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            await expect(resolveIdentity(new Request("https://example.test/documents/list"))).resolves.toBeNull();
        });

        it("fails closed without a secret, and does not call the object", async () => {
            expect.assertions(2);

            const { namespace, requests } = createNamespace(() => ok({ userId: "user_123" }));
            const { resolveIdentity } = createDoAuthWiring({ internalSecret: undefined, namespace });

            await expect(resolveIdentity(new Request("https://example.test/documents/list"))).resolves.toBeNull();

            // No point spending a round-trip the object is certain to refuse.
            expect(requests).toHaveLength(0);
        });

        it("treats a refusal from the object as anonymous rather than throwing", async () => {
            expect.assertions(1);

            const { namespace } = createNamespace(() => Response.json({ error: "unauthorized" }, { status: 401 }));
            const { resolveIdentity } = createDoAuthWiring({ internalSecret: SECRET, namespace });

            // This runs for every request touching `ctx.auth`; a throw here would 500
            // traffic that has nothing to do with auth.
            await expect(resolveIdentity(new Request("https://example.test/documents/list"))).resolves.toBeNull();
        });
    });

    it("addresses the object by name, defaulting to `auth`", async () => {
        expect.assertions(2);

        const first = createNamespace(() => ok({}));
        const second = createNamespace(() => ok({}));

        await createDoAuthWiring({ internalSecret: SECRET, namespace: first.namespace }).resolveIdentity(new Request("https://example.test/x"));
        await createDoAuthWiring({ internalSecret: SECRET, namespace: second.namespace, objectName: "auth-eu" }).resolveIdentity(
            new Request("https://example.test/x"),
        );

        expect(first.names).toStrictEqual(["auth"]);
        expect(second.names).toStrictEqual(["auth-eu"]);
    });

    it("builds the session URL from the request's own origin", async () => {
        expect.assertions(1);

        const { namespace, requests } = createNamespace(() => ok({}));
        const { resolveIdentity } = createDoAuthWiring({ internalSecret: SECRET, namespace });

        await resolveIdentity(new Request("https://tenant.example.test/deep/path?q=1"));

        // A relative URL would throw; a hardcoded origin would break custom domains.
        expect(requests[0]?.url).toBe("https://tenant.example.test/__lunora/auth/session");
    });
});
