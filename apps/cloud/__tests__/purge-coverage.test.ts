import { describe, expect, it } from "vitest";

import { orgPurgeTables, PURGED_ELSEWHERE } from "../lunora/organizations";
import schema from "../lunora/schema";

/**
 * The right-to-erasure purge deletes every table that carries an `organizationId`,
 * except the ones `PURGED_ELSEWHERE` names with the step that handles each. The list
 * is derived from the schema, so these tests check the derivation and the exceptions
 * against the schema rather than against a copy of it.
 */

const tablesWithOrganization = (): string[] =>
    Object.entries<{ shape: object }>(schema.tables)
        .filter(([, table]) => "organizationId" in table.shape)
        .map(([name]) => name);

describe("organizations.purgeDeleted coverage", () => {
    it("purges every table the schema gives an organizationId, except the named exceptions", () => {
        const purged = new Set<string>(orgPurgeTables());

        expect(tablesWithOrganization().filter((table) => !purged.has(table) && !(table in PURGED_ELSEWHERE))).toStrictEqual([]);
    });

    it("names only exceptions that exist in the schema, so a removed table cannot leave a stale exception behind", () => {
        const tables = Object.keys(schema.tables);

        expect(Object.keys(PURGED_ELSEWHERE).filter((table) => !tables.includes(table))).toStrictEqual([]);
    });

    it("never purges a table it names as an exception", () => {
        const purged = new Set<string>(orgPurgeTables());

        expect(Object.keys(PURGED_ELSEWHERE).filter((table) => purged.has(table))).toStrictEqual([]);
    });

    it("purges githubInstallations, whose organizationId is optional", () => {
        expect(orgPurgeTables()).toContain("githubInstallations");
    });
});
