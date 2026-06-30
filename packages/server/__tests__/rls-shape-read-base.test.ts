/**
 * Shapes honour table RLS read policies (the local-first partial-replication
 * security gap).
 *
 * A `defineShape` replicates a table partition to a client but runs NO
 * procedure, so the `.use(rls(...))` middleware never fires. The fix hoists each
 * function's read policies onto `fn.rls` (the procedure builder) and AND-merges
 * the table's read base-where into the shape's predicate at resolve time. These
 * tests pin both halves: the registry build (policy discovery + role union) and
 * the compose (AND-merge, unrestricted pass-through, and fail-closed parity with
 * a `.rls("required")` schema).
 */
import { describe, expect, it } from "vitest";

import { buildRlsReadRegistry, composeShapeReadWhere, definePermission, definePolicies, definePolicy, defineRole, initLunora, rls } from "../src/index";

const builders = initLunora.dataModel<unknown>().create();

/** A registered query carrying the given read policies (+ roles) on `fn.rls`. */
const guardedQuery = (policies: Parameters<typeof rls>[0], options?: Parameters<typeof rls>[1]) =>
    (builders.query as unknown as { use: (m: unknown) => { query: (h: () => unknown) => unknown } }).use(rls(policies, options)).query(() => null);

describe("buildRlsReadRegistry", () => {
    it("hoists a procedure's read policies onto fn.rls and groups them by table", () => {
        expect.assertions(2);

        const readDocs = definePolicy({
            on: "read",
            table: "docs",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const fn = guardedQuery(definePolicies([readDocs]));

        expect((fn as { rls?: unknown }).rls).toBeDefined();

        const registry = buildRlsReadRegistry([fn]);

        expect(registry.byTable.get("docs")).toHaveLength(1);
    });

    it("ignores non-read policies and folds a shared rls() middleware once", () => {
        expect.assertions(3);

        const readDocs = definePolicy({ on: "read", table: "docs", when: () => true });
        const writeDocs = definePolicy({ on: "insert", table: "docs", when: () => true });
        // One shared `rls(...)` middleware reused by two procedures — the same tag
        // reference, so the registry folds it to a single read-policy group.
        const guard = rls(definePolicies([readDocs, writeDocs]));
        const use = (middleware: unknown) =>
            (builders.query as unknown as { use: (m: unknown) => { query: (h: () => unknown) => unknown } }).use(middleware).query(() => null);
        const registry = buildRlsReadRegistry([use(guard), use(guard)]);

        const groups = registry.byTable.get("docs");

        expect(groups).toHaveLength(1);
        // The write policy never lands in the read registry.
        expect(groups?.[0]?.policies).toHaveLength(1);
        expect(groups?.[0]?.policies?.[0]?.on).toBe("read");
    });

    it("scopes auth.can(...) to each tag's roles — a permission on another middleware can't satisfy a policy", () => {
        expect.assertions(2);

        const secret = definePermission("docs:read-all");
        // `guardedDocs` checks `auth.can(secret)` but registers NO role that grants
        // it, so under its own scope no caller can pass.
        const readDocs = definePolicy({
            on: "read",
            table: "docs",
            when: ({ auth }) => (auth.can(secret) ? true : { ownerId: auth.userId }),
        });
        const guardedDocs = guardedQuery(definePolicies([readDocs]));

        // A SEPARATE middleware on an unrelated table grants `secret` to "admin".
        // Pre-fix this leaked into the global role map and satisfied `readDocs`.
        const readNotes = definePolicy({ on: "read", table: "notes", when: () => true });
        const admin = defineRole("admin", { permissions: [secret] });
        const guardedNotes = guardedQuery(definePolicies([readNotes]), { roles: [admin] });

        const registry = buildRlsReadRegistry([guardedDocs, guardedNotes]);

        const asAdmin = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: ["admin"],
            shapeWhere: { channelId: "c1" },
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        // `docs`'s policy never granted `secret` under its own roles, so the admin
        // is scoped to their own rows — the cross-middleware permission is ignored.
        expect(asAdmin).toStrictEqual({ AND: [{ ownerId: "u1" }, { channelId: "c1" }] });

        // The `notes` shape, whose own middleware DOES grant the role, stays open.
        const notesAsAdmin = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: ["admin"],
            shapeWhere: { channelId: "c1" },
            table: "notes",
            tablePublic: false,
            userId: "u1",
        });

        expect(notesAsAdmin).toStrictEqual({ channelId: "c1" });
    });
});

describe("composeShapeReadWhere", () => {
    const shapeWhere = { channelId: "c1" };

    it("aND-merges the read base-where with the shape predicate", () => {
        expect.assertions(1);

        const readDocs = definePolicy({
            on: "read",
            table: "docs",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const registry = buildRlsReadRegistry([guardedQuery(definePolicies([readDocs]))]);

        const effective = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: false,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        expect(effective).toStrictEqual({ AND: [{ ownerId: "u1" }, shapeWhere] });
    });

    it("returns the shape predicate unchanged when a read policy grants the whole table (`true`)", () => {
        expect.assertions(1);

        const readDocs = definePolicy({ on: "read", table: "docs", when: () => true });
        const registry = buildRlsReadRegistry([guardedQuery(definePolicies([readDocs]))]);

        const effective = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: false,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        expect(effective).toStrictEqual(shapeWhere);
    });

    it("returns the shape predicate unchanged for a table with no read policy under a non-required schema", () => {
        expect.assertions(1);

        const registry = buildRlsReadRegistry([]);

        const effective = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: false,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        expect(effective).toStrictEqual(shapeWhere);
    });

    it('fails closed (replicates nothing) for a protected, policy-less table under .rls("required")', () => {
        expect.assertions(1);

        const registry = buildRlsReadRegistry([]);

        const effective = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        // `{ OR: [] }` is the vacuously-false sentinel — a `.public()` table or a
        // policied table would not hit this branch.
        expect(effective).toStrictEqual({ OR: [] });
    });

    it('passes a .public() table through under .rls("required") even with no policy', () => {
        expect.assertions(1);

        const registry = buildRlsReadRegistry([]);

        const effective = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: true,
            userId: "u1",
        });

        expect(effective).toStrictEqual(shapeWhere);
    });

    it("resolves auth.can(...) against the request's roles exactly like the request path", () => {
        expect.assertions(2);

        const readAll = definePermission("docs:read-all");
        const admin = defineRole("admin", { permissions: [readAll] });
        const readDocs = definePolicy({
            on: "read",
            table: "docs",
            // Admins see everything; everyone else only their own rows.
            when: ({ auth }) => (auth.can(readAll) ? true : { ownerId: auth.userId }),
        });
        const registry = buildRlsReadRegistry([guardedQuery(definePolicies([readDocs]), { roles: [admin] })]);

        const asAdmin = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: ["admin"],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        // Admin's `true` predicate → unrestricted → shape where unchanged.
        expect(asAdmin).toStrictEqual(shapeWhere);

        const asUser = composeShapeReadWhere(registry, {
            ctx: {},
            identity: null,
            rlsRequired: true,
            roles: [],
            shapeWhere,
            table: "docs",
            tablePublic: false,
            userId: "u1",
        });

        expect(asUser).toStrictEqual({ AND: [{ ownerId: "u1" }, shapeWhere] });
    });
});
