import { describe, expect, it } from "vitest";

import { definePermission, definePolicies, definePolicy, defineRole } from "../src/rls/define";
import { expectPolicy } from "../src/rls/testing";

/**
 * Exercises the in-process RLS harness (`expectPolicy`). It must answer
 * read-visibility and write allow/deny identically to the `rls()` middleware,
 * because it reuses the middleware's own evaluation primitives — these tests
 * pin that contract (default-DENY, OR-merge, fail-closed abstention, WITH
 * CHECK, permission resolution, unguarded passthrough).
 */
describe("expectPolicy harness", () => {
    it("filters reads to the matching baseWhere (visible vs hidden row)", () => {
        expect.assertions(2);

        const policies = definePolicies([
            definePolicy({
                on: "read",
                table: "docs",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
        ]);
        const ada = expectPolicy(policies).as({ userId: "ada" });

        expect(ada.can("read", "docs", { ownerId: "ada" })).toBe(true);
        expect(ada.can("read", "docs", { ownerId: "linus" })).toBe(false);
    });

    it("treats a read policy returning `true` as unrestricted", () => {
        expect.assertions(1);

        const policies = definePolicies([definePolicy({ on: "read", table: "docs", when: () => true })]);

        expect(expectPolicy(policies).as({ userId: "ada" }).can("read", "docs", { ownerId: "anyone" })).toBe(true);
    });

    it("fails closed when every read policy abstains (all `undefined`)", () => {
        expect.assertions(1);

        // A read-guarded table whose only policy opts out must hide every row,
        // never reveal them — mirrors computeReadBaseWhere's fail-closed branch.
        const policies = definePolicies([definePolicy({ on: "read", table: "docs", when: () => undefined })]);

        expect(expectPolicy(policies).as({ userId: "ada" }).can("read", "docs", { ownerId: "ada" })).toBe(false);
    });

    it("oR-merges multiple read policies (either grant reveals the row)", () => {
        expect.assertions(3);

        const policies = definePolicies([
            definePolicy({
                on: "read",
                table: "docs",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
            definePolicy({
                on: "read",
                table: "docs",
                when: () => {
                    return { shared: true };
                },
            }),
        ]);
        const ada = expectPolicy(policies).as({ userId: "ada" });

        expect(ada.can("read", "docs", { ownerId: "ada", shared: false })).toBe(true);
        expect(ada.can("read", "docs", { ownerId: "linus", shared: true })).toBe(true);
        expect(ada.can("read", "docs", { ownerId: "linus", shared: false })).toBe(false);
    });

    it("evaluates an insert policy against the candidate row", () => {
        expect.assertions(2);

        const policies = definePolicies([definePolicy({ on: "insert", table: "docs", when: ({ auth, row }) => row?.["ownerId"] === auth.userId })]);
        const ada = expectPolicy(policies).as({ userId: "ada" });

        expect(ada.can("insert", "docs", { ownerId: "ada" })).toBe(true);
        expect(ada.cannot("insert", "docs", { ownerId: "linus" })).toBe(true);
    });

    it("denies a write op on a participating table that declares no policy for it (default-DENY)", () => {
        expect.assertions(1);

        // Only a read policy → the table participates, so writes are denied
        // unless an explicit write policy permits them.
        const policies = definePolicies([definePolicy({ on: "read", table: "docs", when: () => true })]);

        expect(expectPolicy(policies).as({ userId: "ada" }).can("delete", "docs", { ownerId: "ada" })).toBe(false);
    });

    it("allows any op on an unguarded table (no policy in the list)", () => {
        expect.assertions(2);

        const policies = definePolicies([definePolicy({ on: "read", table: "docs", when: () => true })]);
        const ada = expectPolicy(policies).as({ userId: "ada" });

        // "other" has no policy → middleware never wraps it → unrestricted.
        expect(ada.can("read", "other", { x: 1 })).toBe(true);
        expect(ada.can("insert", "other", { x: 1 })).toBe(true);
    });

    it("enforces WITH CHECK on update via the post-image row", () => {
        expect.assertions(2);

        const policies = definePolicies([
            definePolicy({
                on: "update",
                table: "docs",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
        ]);
        const ada = expectPolicy(policies).as({ userId: "ada" });

        // Old row owned by ada; patch keeps her as owner → allowed.
        expect(ada.can("update", "docs", { ownerId: "ada" }, { ownerId: "ada" })).toBe(true);
        // Old row owned by ada, but the patch reassigns to linus → WITH CHECK denies.
        expect(ada.can("update", "docs", { ownerId: "ada" }, { ownerId: "linus" })).toBe(false);
    });

    it("resolves permissions through the role registry for auth.can(...)", () => {
        expect.assertions(2);

        const deletePosts = definePermission("posts:delete");
        const admin = defineRole("admin", { permissions: [deletePosts] });
        const policies = definePolicies([definePolicy({ on: "delete", table: "posts", when: ({ auth }) => auth.can(deletePosts) })]);
        const harness = expectPolicy(policies, { roles: [admin] });

        expect(harness.as({ roles: ["admin"], userId: "a" }).can("delete", "posts", { id: "p1" })).toBe(true);
        // A role not registered in the harness grants nothing — fail closed.
        expect(harness.as({ roles: ["editor"], userId: "b" }).can("delete", "posts", { id: "p1" })).toBe(false);
    });

    it("exposes ctx and identity to policies", () => {
        expect.assertions(2);

        const policies = definePolicies([
            definePolicy<{ orgId: string }>({
                on: "read",
                table: "docs",
                when: ({ ctx }) => {
                    return { orgId: ctx.orgId };
                },
            }),
        ]);
        const harness = expectPolicy(policies, { ctx: { orgId: "acme" } });

        expect(harness.as({ userId: "ada" }).can("read", "docs", { orgId: "acme" })).toBe(true);
        expect(harness.as({ userId: "ada" }).can("read", "docs", { orgId: "globex" })).toBe(false);
    });

    it("rejects a relation predicate in a write policy (same loud error the middleware throws)", () => {
        expect.assertions(1);

        const policies = definePolicies([
            definePolicy({
                on: "insert",
                table: "docs",
                when: () => {
                    return { author: { is: { id: "x" } } };
                },
            }),
        ]);

        expect(() => expectPolicy(policies).as({ userId: "ada" }).can("insert", "docs", { ownerId: "ada" })).toThrow(/relation predicates are not supported/u);
    });

    it("defaults an omitted identity to the anonymous caller (userId null)", () => {
        expect.assertions(1);

        const policies = definePolicies([
            definePolicy({
                on: "read",
                table: "docs",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
        ]);

        // userId null never equals a real ownerId → nothing visible.
        expect(expectPolicy(policies).as().can("read", "docs", { ownerId: "ada" })).toBe(false);
    });
});
