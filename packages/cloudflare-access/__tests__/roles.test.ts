import { describe, expect, it, vi } from "vitest";

import type { AccessRolesContext, AccessRolesOptions } from "../src/roles";
import { accessRoles } from "../src/roles";

/**
 * Drive `accessRoles` once: build a ctx whose `auth.getIdentity()` returns
 * `identity`, run the middleware, and report what reached `next`. `roles` is the
 * `ctx.auth.roles` the chain would see downstream; `passedThrough` is true when
 * the middleware forwarded the context unchanged (`next()` with no extension).
 */
const run = async (
    identity: Record<string, unknown> | null,
    options: AccessRolesOptions = {},
    existingRoles?: ReadonlyArray<string>,
): Promise<{ passedThrough: boolean; roles: ReadonlyArray<string> | undefined }> => {
    const auth: AccessRolesContext["auth"] = {
        getIdentity: () => identity,
        roles: existingRoles,
        userId: identity ? "user-1" : null,
    };
    const ctx = { auth } satisfies AccessRolesContext;

    let captured: { ctx: Record<string, unknown> } | undefined;

    const next = vi.fn<(arguments_?: { ctx: Record<string, unknown> }) => Promise<Record<string, unknown>>>((arguments_) => {
        captured = arguments_;

        return Promise.resolve({ ...ctx, ...arguments_?.ctx });
    });

    await accessRoles(options)({ ctx, next });

    const nextAuth = captured?.ctx.auth as { roles?: ReadonlyArray<string> } | undefined;

    return { passedThrough: captured === undefined, roles: nextAuth?.roles ?? auth.roles };
};

describe("accessRoles", () => {
    it("uses each group verbatim as a role when no map is given", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["admins", "billing"] });

        expect(roles).toStrictEqual(["admins", "billing"]);
    });

    it("maps groups to roles through a lookup table (single and array values)", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["idp-admins", "idp-billing"] }, { map: { "idp-admins": "admin", "idp-billing": ["billing", "viewer"] } });

        expect(roles).toStrictEqual(["admin", "billing", "viewer"]);
    });

    it("drops a group the table does not map", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["idp-admins", "unmapped"] }, { map: { "idp-admins": "admin" } });

        expect(roles).toStrictEqual(["admin"]);
    });

    it("supports a function map", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["admins", "skip", "eng"] }, { map: (group) => (group === "skip" ? undefined : `role:${group}`) });

        expect(roles).toStrictEqual(["role:admins", "role:eng"]);
    });

    it("unions group-derived roles with roles already on ctx.auth, deduped", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["editor", "admin"] }, {}, ["admin", "viewer"]);

        expect(roles).toStrictEqual(["admin", "viewer", "editor"]);
    });

    it("forwards the context unchanged when there is no identity", async () => {
        expect.assertions(2);

        const result = await run(null);

        expect(result.passedThrough).toBe(true);
        expect(result.roles).toBeUndefined();
    });

    it("forwards the context unchanged when the identity carries no groups", async () => {
        expect.assertions(1);

        const result = await run({ email: "a@b.c" });

        expect(result.passedThrough).toBe(true);
    });

    it("forwards unchanged when the groups list is empty", async () => {
        expect.assertions(1);

        const result = await run({ groups: [] });

        expect(result.passedThrough).toBe(true);
    });

    it("reads groups from a custom location via readGroups", async () => {
        expect.assertions(1);

        const { roles } = await run({ access: { custom: ["a", "b"] } }, { readGroups: (identity) => (identity.access as { custom: string[] }).custom });

        expect(roles).toStrictEqual(["a", "b"]);
    });

    it("ignores non-string entries in the default groups claim", async () => {
        expect.assertions(1);

        const { roles } = await run({ groups: ["ok", 42, null, "fine"] });

        expect(roles).toStrictEqual(["ok", "fine"]);
    });

    it("falls back to the nested access.groups claim when groups is not promoted", async () => {
        expect.assertions(1);

        // A custom `mapClaims` that stops promoting `groups` to the envelope top
        // still leaves the verified claim set under `access` (the resolver shape);
        // the default reader must read groups from there, not strip every role.
        const { roles } = await run({ access: { groups: ["admins", "billing"] } });

        expect(roles).toStrictEqual(["admins", "billing"]);
    });

    it("prefers the promoted top-level groups over the nested access.groups", async () => {
        expect.assertions(1);

        const { roles } = await run({ access: { groups: ["nested"] }, groups: ["promoted"] });

        expect(roles).toStrictEqual(["promoted"]);
    });
});
