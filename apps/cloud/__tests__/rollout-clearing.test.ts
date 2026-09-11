import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { activate, rollback } from "../lunora/deployments";

/**
 * Every path that moves a project's active pointer must also clear its rollout.
 *
 * This exists because they did not, and the failure was invisible. `activate` is
 * the mutation CI calls on every deploy: it superseded the rollout candidate and
 * left the rollout set, so the dispatcher kept routing a share of production
 * traffic to a script the same mutation had just retired — indefinitely, and then
 * to a 404 once the teardown sweep deleted it. `rollback` had the same hole, with
 * a worse consequence: it is the control an operator reaches for when a release
 * misbehaves, and it reported success while the bad canary kept serving.
 *
 * Driven through `.handler(ctx, args)` against a fake ctx, which is how
 * `deployments.test.ts` exercises `cleanupExpiredPreviews`. An earlier version of
 * this file scanned the SOURCE for `rollout: undefined` with a hand-rolled brace
 * walker — it would have failed on a correct refactor and passed on a wrong one,
 * and its stated excuse (that a behavioural test needs a live control plane) was
 * untrue in the same directory.
 */

type Row = Record<string, unknown>;

const PROJECT = "prj_1";
const ORG = "org_1";

/**
 * A mutation ctx over in-memory deployment rows.
 *
 * `assertMember` reads `members` and the caller identity, so the double supplies
 * an owner; everything else the pointer paths touch is `deployments`, `projects`
 * and the audit insert.
 */
const makeCtx = (rows: Row[]): { ctx: MutationCtx; patched: { id: string; patch: Row }[] } => {
    const patched: { id: string; patch: Row }[] = [];
    const byId = new Map(rows.map((row) => [row["_id"] as string, row]));

    const tables: Record<string, Row[]> = { deployments: rows, members: [{ _id: "mem_1", organizationId: ORG, role: "owner", userId: "usr_1" }], projects: [] };
    const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);
    const findMany = (table: string) => (args?: { where?: Row }) =>
        Promise.resolve({ page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) });

    // `activate`/`rollback` carry `.use(rateLimit("machine"))`, and `.handler`
    // runs the middleware chain — so the double also has to satisfy the limiter's
    // store: a `query(table).withIndex(...).first()` that finds no existing bucket,
    // which is the "first request from this caller" path and always allows.
    const emptyQuery: { first: () => Promise<null>; withIndex: () => typeof emptyQuery } = {
        first: () => Promise.resolve(null),
        withIndex: () => emptyQuery,
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve({ subject: "usr_1" }), userId: "usr_1" },
        db: {
            deployments: { findMany: findMany("deployments") },
            query: () => emptyQuery,
            get: (id: string) => Promise.resolve(byId.get(id) ?? { _id: id, organizationId: ORG, slug: "web" }),
            insert: () => Promise.resolve("row_1"),
            members: { findMany: findMany("members") },
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
            projects: { findMany: findMany("projects") },
        },
        log: { info: () => undefined },
        now: 1_700_000_000_000,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, patched };
};

const deployment = (over: Row = {}): Row => {
    return {
        _id: "dep_new",
        kind: "production",
        organizationId: ORG,
        projectId: PROJECT,
        scriptName: "app-v2",
        status: "live",
        ...over,
    };
};

/** The patch a pointer-moving mutation writes to the PROJECT row. */
const pointerPatch = (patched: { id: string; patch: Row }[]): Row | undefined => patched.find((entry) => entry.id === PROJECT)?.patch;

describe("deployments.activate", () => {
    it("clears the rollout when it moves the active pointer", async () => {
        const { ctx, patched } = makeCtx([deployment(), deployment({ _id: "dep_old", scriptName: "app-v1", status: "live" })]);

        await activate.handler(ctx, { id: "dep_new" as never });

        const patch = pointerPatch(patched);

        expect(patch).toMatchObject({ activeDeploymentId: "dep_new", activeScriptName: "app-v2" });
        // The property this file exists for: a new release ends any rollout.
        expect(patch).toHaveProperty("rollout", null);
    });

    it("supersedes the previously-live release of the same kind", async () => {
        const { ctx, patched } = makeCtx([deployment(), deployment({ _id: "dep_old", scriptName: "app-v1", status: "live" })]);

        await activate.handler(ctx, { id: "dep_new" as never });

        expect(patched.find((entry) => entry.id === "dep_old")?.patch).toMatchObject({ status: "superseded" });
    });
});

describe("deployments.rollback", () => {
    it("clears the rollout when it moves the active pointer back", async () => {
        const { ctx, patched } = makeCtx([
            deployment({ _id: "dep_old", scriptName: "app-v1", status: "superseded" }),
            deployment({ _id: "dep_live", scriptName: "app-v2", status: "live" }),
        ]);

        await rollback.handler(ctx, { id: "dep_old" as never, organizationId: ORG as never });

        const patch = pointerPatch(patched);

        expect(patch).toMatchObject({ activeScriptName: "app-v1" });
        // The worse half of the original bug: rolling back a bad release while
        // leaving its canary serving a share of traffic, and reporting success.
        expect(patch).toHaveProperty("rollout", null);
    });
});
