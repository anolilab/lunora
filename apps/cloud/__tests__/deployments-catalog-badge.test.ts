import { describe, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import type { MutationCtx } from "../lunora/_generated/server";
import { activate, rollback, updateStatus } from "../lunora/deployments";

/**
 * A catalog install's badge follows its deployment. These drive the real mutations
 * against an in-memory store that records every write, so a test can assert both the
 * result and that nothing else was touched.
 */

type Row = Record<string, unknown> & { _id: string };

interface Store {
    ctx: MutationCtx;
    rows: (table: string) => Row[];
    writes: { op: "delete" | "insert" | "patch"; table: string }[];
}

const matches = (row: Row, where: Record<string, unknown> = {}): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

/** The fake database: one table per name, with the methods the handlers call. */
const storeWith = (tables: Record<string, Row[]>, auth: { userId: string }): Store => {
    const data = new Map<string, Row[]>(
        Object.entries(tables).map(([name, rows]) => [
            name,
            rows.map((row) => {
                return { ...row };
            }),
        ]),
    );
    const writes: Store["writes"] = [];
    let counter = 0;

    const tableRows = (name: string): Row[] => data.get(name) ?? [];
    const locate = (id: string): { row: Row; table: string } | undefined => {
        for (const [table, rows] of data) {
            const row = rows.find((candidate) => candidate._id === id);

            if (row !== undefined) {
                return { row, table };
            }
        }

        return undefined;
    };

    const accessor = (name: string) => {
        return {
            findMany: (arguments_?: { where?: Record<string, unknown> }) => {
                const page = tableRows(name)
                    .filter((row) => matches(row, arguments_?.where))
                    .map((row) => {
                        return { ...row };
                    });

                return Promise.resolve({ page });
            },
            get: (id: string) => Promise.resolve(locate(id)?.row ? { ...locate(id)?.row } : null),
        };
    };

    const methods: Record<string, unknown> = {
        delete: (id: string) => {
            const found = locate(id);

            if (found) {
                const rows = data.get(found.table) ?? [];

                data.set(
                    found.table,
                    rows.filter((row) => row._id !== id),
                );
                writes.push({ op: "delete", table: found.table });
            }

            return Promise.resolve();
        },
        get: (id: string) => Promise.resolve(locate(id)?.row ? { ...locate(id)?.row } : null),
        insert: (table: string, row: Record<string, unknown>) => {
            counter += 1;
            const id = `${table}_new_${String(counter)}`;

            data.set(table, [...tableRows(table), { ...row, _id: id }]);
            writes.push({ op: "insert", table });

            return Promise.resolve(id);
        },
        patch: (id: string, values: Record<string, unknown>) => {
            const found = locate(id);

            if (found) {
                Object.assign(found.row, values);
                writes.push({ op: "patch", table: found.table });
            }

            return Promise.resolve();
        },
        // The machine rate limiter reads its bucket through `query`; no bucket yet means a fresh one.
        query: () => {
            return {
                withIndex: () => {
                    return { first: () => Promise.resolve(null) };
                },
            };
        },
    };
    // Table accessors come from the proxy, so `db.catalogInstalls` and the like work without listing them.
    const db = new Proxy(methods, {
        get: (target, property) => {
            const key = String(property);

            return key in target ? target[key] : accessor(key);
        },
    });

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: auth.userId },
        db,
        log: {},
        now: 1000,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return {
        ctx,
        rows: (table) =>
            tableRows(table).map((row) => {
                return { ...row };
            }),
        writes,
    };
};

const ORG = "org_1";
const member = { _id: "member_1", organizationId: ORG, role: "owner", userId: "user_owner" };

/** Project P1 runs a catalog app (`dep_catalog`); the older normal release `dep_normal_old` is its rollback target. */
const catalogProject = {
    catalogInstalls: [
        {
            _id: "install_1",
            activeKey: "live:install_1",
            createdAt: 1,
            deploymentId: "dep_catalog",
            installedBy: "user_owner",
            organizationId: ORG,
            projectId: "proj_1",
            slug: "counter",
            status: "live",
            version: "1.0.0",
        },
    ],
    deployments: [
        {
            _id: "dep_catalog",
            alias: "counter",
            createdAt: 2,
            kind: "production",
            organizationId: ORG,
            projectId: "proj_1",
            scriptName: "counter-prod",
            status: "live",
        },
        {
            _id: "dep_normal_old",
            alias: "counter",
            createdAt: 1,
            kind: "production",
            organizationId: ORG,
            projectId: "proj_1",
            scriptName: "counter-prod",
            status: "superseded",
        },
    ],
    members: [member],
    projects: [{ _id: "proj_1", name: "Counter", organizationId: ORG }],
};

describe("a catalog install's badge follows its deployment", () => {
    it("removes a catalog install's row when a rollback moves the project off its deployment", async () => {
        const store = storeWith(catalogProject, { userId: "user_owner" });

        await rollback.handler(store.ctx, { id: "dep_normal_old" as Id<"deployments">, organizationId: ORG as Id<"organizations"> });

        expect(store.rows("catalogInstalls")).toStrictEqual([]);
        expect(store.rows("deployments").find((row) => row._id === "dep_normal_old")).toMatchObject({ status: "live" });
        expect(store.rows("deployments").find((row) => row._id === "dep_catalog")).toMatchObject({ status: "superseded" });
    });

    it("leaves every install row alone when a normal deploy goes live on a project with no catalog install", async () => {
        const store = storeWith(
            {
                ...catalogProject,
                deployments: [
                    {
                        _id: "dep_p2_live",
                        alias: "app",
                        createdAt: 1,
                        kind: "production",
                        organizationId: ORG,
                        projectId: "proj_2",
                        scriptName: "app-prod",
                        status: "live",
                    },
                    {
                        _id: "dep_p2_new",
                        alias: "app",
                        createdAt: 2,
                        kind: "production",
                        organizationId: ORG,
                        projectId: "proj_2",
                        scriptName: "app-prod",
                        status: "verifying",
                    },
                ],
            },
            { userId: "user_owner" },
        );

        await activate.handler(store.ctx, { id: "dep_p2_new" as Id<"deployments"> });

        expect(store.rows("deployments").find((row) => row._id === "dep_p2_live")).toMatchObject({ status: "superseded" });
        expect(store.writes.filter((write) => write.table === "catalogInstalls")).toStrictEqual([]);
        expect(store.rows("catalogInstalls")).toHaveLength(1);
    });

    it("removes a catalog install's row when its deployment is superseded by a status update", async () => {
        const store = storeWith(catalogProject, { userId: "user_owner" });

        await updateStatus.handler(store.ctx, { id: "dep_catalog" as Id<"deployments">, status: "superseded" });

        expect(store.rows("catalogInstalls")).toStrictEqual([]);
    });

    it("never touches a row that is still installing, even one that names the deployment", async () => {
        const store = storeWith(
            {
                ...catalogProject,
                catalogInstalls: [
                    {
                        _id: "install_2",
                        activeKey: "proj_1",
                        createdAt: 1,
                        deploymentId: "dep_catalog",
                        installedBy: "user_owner",
                        organizationId: ORG,
                        projectId: "proj_1",
                        slug: "counter",
                        status: "installing",
                        version: "1.1.0",
                    },
                ],
            },
            { userId: "user_owner" },
        );

        await rollback.handler(store.ctx, { id: "dep_normal_old" as Id<"deployments">, organizationId: ORG as Id<"organizations"> });

        expect(store.rows("catalogInstalls")).toMatchObject([{ _id: "install_2", status: "installing" }]);
    });
});
