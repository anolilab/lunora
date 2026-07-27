import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AUTH_DO_SECRET_HEADER, AUTH_DO_SESSION_PATH } from "../../src/index";
import { INTERNAL_SECRET, SCIM_TOKEN } from "./test-worker";

/**
 * `lunoraDoAdapter` against a **real** Durable Object in workerd.
 *
 * The Node suite proves the adapter contract using `node:sqlite` with BEGIN/COMMIT,
 * which reproduces atomicity and rollback but not the platform's own primitive. This
 * one runs better-auth inside an actual SQLite-backed Durable Object, so
 * `state.storage.transaction` is the real thing — the property that decides whether
 * `@better-auth/scim` (which D1 cannot satisfy at all) works on Cloudflare's
 * first-party storage.
 *
 * Requests go through `SELF` → worker → DO stub, i.e. the same path an app's
 * `/api/auth/*` traffic would take.
 */

const scimFetch = async (path: string, method: string, body?: unknown): Promise<Response> =>
    SELF.fetch(`https://example.test/api/auth/scim/v2${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${SCIM_TOKEN}`, "content-type": "application/scim+json" },
        method,
    });

describe("lunoraDoAdapter in workerd", () => {
    it("serves SCIM from inside a Durable Object", async () => {
        expect.assertions(2);

        const response = await scimFetch("/Users", "GET");

        // A 200 here means the plugin accepted the adapter — on D1 this request never
        // gets past `The scim plugin requires a database adapter with native transaction
        // support`, which is the entire reason this adapter exists.
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"] });
    });

    it("rejects a bad credential, so the 200 above is not an open door", async () => {
        expect.assertions(1);

        const response = await SELF.fetch("https://example.test/api/auth/scim/v2/Users", {
            headers: { authorization: "Bearer not-the-token" },
        });

        expect(response.status).toBe(401);
    });

    it("provisions a user into the object's own SQLite", async () => {
        expect.assertions(2);

        const created = await scimFetch("/Users", "POST", {
            active: true,
            emails: [{ primary: true, value: "ada@acme.test" }],
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: "ada@acme.test",
        });

        expect(created.status).toBe(201);

        // Read the object's `user` table back out, so this asserts durable state in the
        // DO rather than just the SCIM projection in the response.
        const users = await SELF.fetch("https://example.test/__users");

        await expect(users.json()).resolves.toMatchObject({ users: [{ email: "ada@acme.test" }] });
    });

    it("round-trips deactivate and reactivate through the real transaction primitive", async () => {
        expect.assertions(3);

        const created = await scimFetch("/Users", "POST", {
            active: true,
            emails: [{ primary: true, value: "grace@acme.test" }],
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: "grace@acme.test",
        });
        const createdBody: { id: string } = await created.json();
        const { id } = createdBody;

        const patch = async (value: boolean): Promise<Response> =>
            scimFetch(`/Users/${id}`, "PATCH", {
                Operations: [{ op: "replace", path: "active", value }],
                schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            });

        // Each PATCH runs inside `state.storage.transaction`, so this exercises the
        // primitive repeatedly rather than once at construction.
        const deactivation = await patch(false);

        expect(deactivation.status).toBe(204);

        const deactivated = await scimFetch(`/Users/${id}`, "GET");

        await expect(deactivated.json()).resolves.toMatchObject({ active: false });

        await patch(true);

        const reactivated = await scimFetch(`/Users/${id}`, "GET");

        await expect(reactivated.json()).resolves.toMatchObject({ active: true });
    });

    it("answers the worker's identity question, but only with the internal secret", async () => {
        expect.assertions(3);

        const ask = async (headers: Record<string, string>): Promise<Response> => SELF.fetch(`https://example.test${AUTH_DO_SESSION_PATH}`, { headers });

        // This route is how `resolveIdentity` works in DO mode, so it is reachable
        // from any worker bound to the namespace — the binding is not the boundary,
        // the secret is. Assert both sides of it in the real runtime, not just Node.
        const anonymous = await ask({});
        const wrongSecret = await ask({ [AUTH_DO_SECRET_HEADER]: "wrong" });

        expect(anonymous.status).toBe(401);
        expect(wrongSecret.status).toBe(401);

        const allowed = await ask({ [AUTH_DO_SECRET_HEADER]: INTERNAL_SECRET });

        // No cookie on this request, so the object reports no user — the point is
        // that it answered at all.
        await expect(allowed.json()).resolves.toStrictEqual({});
    });
});
