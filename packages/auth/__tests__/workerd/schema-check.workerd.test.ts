import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { LunoraAuthOptions } from "../../src/create-auth";
import { resolveAuthOptions } from "../../src/create-auth";
import { authDoSchemaStatements } from "../../src/do-schema";
import { doExecutor } from "../../src/do-store";
import { doTableInfo, findSchemaProblems } from "../../src/schema-check";

/**
 * The schema check's introspection statement, against **real** workerd SQLite.
 *
 * The two backends behind one executor seam do not accept the same statement: D1's
 * authorizer refuses every pragma table-valued function through the Worker binding
 * (see `d1-index-introspection.ts`), while a Durable Object's own SQLite accepts
 * `pragma_table_info(?)` and refuses nothing this needs. A `node:sqlite` suite
 * answers both forms happily and so proves neither — it is a different build of
 * SQLite behind a different authorizer, which is exactly how the `_creationTime`
 * probe in `creation-time-probe.workerd.test.ts` came to be green in Node while
 * every Durable Object insert failed.
 *
 * So this pins the DO half where it actually runs: the statement is accepted, an
 * absent table answers with zero rows rather than an error, and the findings match
 * what the Node suite asserts for the D1 form.
 */

const SECRET = "lunora-workerd-schema-check-secret-lunora-xx";

const options: LunoraAuthOptions = { emailAndPassword: { enabled: true }, secret: SECRET };

/** Each case gets its own Durable Object so one test's schema cannot answer another's introspection. */
const withStorage = async (name: string, assertion: (storage: DurableObjectState["storage"]) => Promise<void>): Promise<void> => {
    const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName(`schema-check-${name}`));

    await runInDurableObject(stub, async (_instance, state) => assertion(state.storage));
};

/** Materialise better-auth's tables the way `LunoraAuthDO` does on a cold start. */
const materialise = (storage: DurableObjectState["storage"], skip?: string): void => {
    for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
        if (skip !== undefined && statement.includes(`"${skip}"`)) {
            continue;
        }

        [...storage.sql.exec(statement)];
    }
};

describe("auth schema check on workerd SQLite", () => {
    it("reports nothing for the schema the Durable Object materialises for itself", async () => {
        expect.assertions(1);

        await withStorage("clean", async (storage) => {
            materialise(storage);

            await expect(findSchemaProblems(resolveAuthOptions(options), doExecutor(storage), doTableInfo)).resolves.toStrictEqual([]);
        });
    });

    it("names a table the object never created, rather than erroring on the read", async () => {
        // `pragma_table_info` on an unknown table must answer with zero rows — an error
        // instead would reject the whole check and it would report nothing at all.
        expect.assertions(1);

        await withStorage("missing-table", async (storage) => {
            materialise(storage, "verification");

            await expect(findSchemaProblems(resolveAuthOptions(options), doExecutor(storage), doTableInfo)).resolves.toStrictEqual([
                { kind: "missing-table", table: "verification" },
            ]);
        });
    });

    it("names a column transcribed under another framework's spelling", async () => {
        expect.assertions(1);

        await withStorage("missing-column", async (storage) => {
            materialise(storage);
            [...storage.sql.exec(`ALTER TABLE "account" RENAME COLUMN "accountId" TO "providerAccountId"`)];

            await expect(findSchemaProblems(resolveAuthOptions(options), doExecutor(storage), doTableInfo)).resolves.toContainEqual({
                column: "accountId",
                kind: "missing-column",
                table: "account",
            });
        });
    });
});
