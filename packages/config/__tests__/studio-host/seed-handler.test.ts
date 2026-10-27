import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleSeedRequest } from "../../src/studio-host/seed-handler";

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    users: defineTable({
        email: v.string(),
        name: v.string(),
    }),
    posts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
    }),
});
`;

describe("handleSeedRequest", () => {
    let projectRoot: string;
    let lunoraDirectory: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-seed-handler-"));
        lunoraDirectory = join(projectRoot, "lunora");
        mkdirSync(lunoraDirectory, { recursive: true });
        writeFileSync(join(lunoraDirectory, "schema.ts"), SCHEMA, "utf8");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("generates the requested number of rows for a table", async () => {
        expect.assertions(3);

        const result = await handleSeedRequest({
            body: { count: 5, table: "users" },
            method: "POST",
            projectRoot,
        });
        const body = result.body as { ok: boolean; rows: ReadonlyArray<Record<string, unknown>> };

        expect(result.status).toBe(200);
        expect(body.rows).toHaveLength(5);
        // System columns are filled by the insert path, not the generator's output payload.
        expect(body.rows[0]).toHaveProperty("email");
    });

    it("is deterministic for the same seed", async () => {
        expect.assertions(1);

        const first = await handleSeedRequest({ body: { count: 3, seed: 42, table: "users" }, method: "POST", projectRoot });
        const second = await handleSeedRequest({ body: { count: 3, seed: 42, table: "users" }, method: "POST", projectRoot });

        expect((first.body as { rows: unknown }).rows).toStrictEqual((second.body as { rows: unknown }).rows);
    });

    it("links foreign keys to supplied existing ids instead of fabricating parents", async () => {
        expect.assertions(2);

        const result = await handleSeedRequest({
            body: { count: 4, existingIds: { users: ["user-a", "user-b"] }, table: "posts" },
            method: "POST",
            projectRoot,
        });
        const body = result.body as { rows: ReadonlyArray<Record<string, unknown>> };

        expect(result.status).toBe(200);
        expect(body.rows.every((row) => row["authorId"] === "user-a" || row["authorId"] === "user-b")).toBe(true);
    });

    it("refuses rather than return children whose parents it would then drop", async () => {
        expect.assertions(2);

        // With no ids for `users`, the planner FABRICATES parent rows and points the
        // posts at them. Only the requested table's rows are returned, so those
        // parents never reach the writer and every returned `authorId` names a row
        // that does not exist — a dangling FK the insert then either rejects or,
        // worse, accepts. The refusal lives in the studio client today, so a request
        // that does not come from it gets the dangling rows.
        const result = await handleSeedRequest({ body: { count: 4, table: "posts" }, method: "POST", projectRoot });

        expect(result.status).toBe(409);
        expect(result.body).toStrictEqual({ error: "fk-parents-empty", ok: false, tables: ["users"] });
    });

    it("refuses a required self-reference into an empty table with a 409, not a thrown 500", async () => {
        expect.assertions(3);

        // The first row of a required self-reference has no earlier row to point at,
        // and the planner refuses it. The endpoint must answer with the refusal, not
        // let the throw escape as a server error the studio cannot explain.
        writeFileSync(
            join(lunoraDirectory, "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    nodes: defineTable({
        name: v.string(),
        parentId: v.id("nodes"),
    }),
});
`,
            "utf8",
        );

        const result = await handleSeedRequest({ body: { count: 3, table: "nodes" }, method: "POST", projectRoot });

        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({ error: "seed-refused", ok: false });
        expect((result.body as { message: string }).message).toMatch(/required foreign key "parentId" points at "nodes"/u);
    });

    it("clamps the count to the safety bound", async () => {
        expect.assertions(1);

        const result = await handleSeedRequest({ body: { count: 100_000, table: "users" }, method: "POST", projectRoot });

        expect((result.body as { rows: ReadonlyArray<unknown> }).rows).toHaveLength(1000);
    });

    it("returns 404 for an unknown table", async () => {
        expect.assertions(1);

        await expect(handleSeedRequest({ body: { table: "nope" }, method: "POST", projectRoot })).resolves.toHaveProperty("status", 404);
    });

    it("returns 404 when the schema file is missing", async () => {
        expect.assertions(1);

        rmSync(join(lunoraDirectory, "schema.ts"));

        await expect(handleSeedRequest({ body: { table: "users" }, method: "POST", projectRoot })).resolves.toHaveProperty("status", 404);
    });

    it("rejects a POST body without a table", async () => {
        expect.assertions(1);

        await expect(handleSeedRequest({ body: { count: 5 }, method: "POST", projectRoot })).resolves.toHaveProperty("status", 400);
    });

    it("rejects a non-object body", async () => {
        expect.assertions(1);

        await expect(handleSeedRequest({ body: undefined, method: "POST", projectRoot })).resolves.toHaveProperty("status", 400);
    });

    it("rejects a body of literal null with a 400 (not a 500 TypeError)", async () => {
        expect.assertions(2);

        // `typeof null === "object"`, so a naive guard destructures null and 500s.
        const result = await handleSeedRequest({ body: null, method: "POST", projectRoot });

        expect(result.status).toBe(400);
        expect(result.body).toStrictEqual({ error: "invalid-request", ok: false });
    });

    it("rejects an unsupported HTTP method", async () => {
        expect.assertions(1);

        await expect(handleSeedRequest({ method: "GET", projectRoot })).resolves.toHaveProperty("status", 405);
    });
});
