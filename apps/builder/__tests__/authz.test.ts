/**
 * The ownership model — `lunora/authz.ts`.
 *
 * Two halves, tested the way each is actually enforced.
 *
 * The `projects` policies run through `expectPolicy`, which evaluates them with
 * the `rls()` middleware's OWN primitives — so a green assertion here means the
 * policy behaves identically at request time, not merely in a lookalike.
 *
 * `authorizeProject` is the cross-tier half: an RLS policy cannot express "the
 * project this sharded row points at is mine" (policy predicates are synchronous
 * and have no database access, and `projects` lives in a different storage tier
 * from its children), so the helper is the boundary and is tested directly. It
 * is exercised against a stub context rather than `lunoraTest` because the
 * harness has no `globalDb` — `.global()` tables cannot be inserted into there
 * ("insert on global table 'projects' requires a globalDb writer").
 */
import { expectPolicy } from "lunorash/server/rls/testing";
import { describe, expect, it } from "vitest";

import { authorizeProject, policies, requireOwner } from "../lunora/authz";

/** A context carrying just what the ownership checks read. */
const stubCtx = (userId: null | string, project: Record<string, unknown> | null): never =>
    ({
        auth: { userId },
        db: {
            asId: (_table: string, id: string) => id,
            get: async () => project,
        },
    }) as never;

describe("projects RLS policies", () => {
    it("shows a signed-in caller only their own projects", () => {
        expect.assertions(2);

        const ada = expectPolicy(policies).as({ userId: "ada" });

        expect(ada.can("read", "projects", { name: "mine", ownerId: "ada" })).toBe(true);
        expect(ada.can("read", "projects", { name: "theirs", ownerId: "linus" })).toBe(false);
    });

    it("denies an anonymous caller every operation on projects", () => {
        expect.assertions(3);

        // The whole point of the fail-closed posture: with no verified identity
        // there is no owner to compare against, so the table answers nothing
        // rather than everything.
        const anonymous = expectPolicy(policies).as();

        expect(anonymous.can("read", "projects", { ownerId: "ada" })).toBe(false);
        expect(anonymous.cannot("insert", "projects", { ownerId: "ada" })).toBe(true);
        expect(anonymous.cannot("update", "projects", { ownerId: "ada" })).toBe(true);
    });

    it("refuses an insert that names somebody else as the owner", () => {
        expect.assertions(2);

        const ada = expectPolicy(policies).as({ userId: "ada" });

        expect(ada.can("insert", "projects", { name: "mine", ownerId: "ada" })).toBe(true);
        expect(ada.cannot("insert", "projects", { name: "planted", ownerId: "linus" })).toBe(true);
    });

    it("refuses a rename of a project the caller does not own", () => {
        expect.assertions(2);

        const ada = expectPolicy(policies).as({ userId: "ada" });

        // `update` evaluates the PRE-WRITE row, which is what stops a caller
        // patching a row they merely know the id of.
        expect(ada.can("update", "projects", { ownerId: "ada" })).toBe(true);
        expect(ada.cannot("update", "projects", { ownerId: "linus" })).toBe(true);
    });
});

describe("requireOwner", () => {
    it("returns the verified caller id", () => {
        expect.assertions(1);

        expect(requireOwner({ auth: { userId: "ada" } })).toBe("ada");
    });

    it("rejects an anonymous caller with 401", () => {
        expect.assertions(1);

        expect(() => requireOwner({ auth: { userId: null } })).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });
});

describe("authorizeProject", () => {
    it("returns the trusted project id for the owner", async () => {
        expect.assertions(1);

        await expect(authorizeProject(stubCtx("ada", { name: "mine", ownerId: "ada" }), "p1")).resolves.toStrictEqual({ ownerId: "ada", projectId: "p1" });
    });

    it("refuses a project owned by somebody else", async () => {
        expect.assertions(1);

        // 404 rather than 403 on purpose: "that id exists but is not yours"
        // turns the dashboard's id space into an enumeration oracle.
        await expect(authorizeProject(stubCtx("ada", { name: "theirs", ownerId: "linus" }), "p2")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a project id that does not resolve", async () => {
        expect.assertions(1);

        await expect(authorizeProject(stubCtx("ada", null), "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses an anonymous caller before it reads anything", async () => {
        expect.assertions(1);

        await expect(authorizeProject(stubCtx(null, { ownerId: "ada" }), "p1")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
});
