import { describe, expect, it } from "vitest";

import paymentExtension from "../src/schema";

// Every payment table is written by the component's store through `database.insert` with a table name held in a constant. The
// installing app's advisor does not scan this package, so each table must declare that write path, or `table_without_insert` fires
// on rows the component always writes.
describe("payment tables declare their write path", () => {
    it.each(["customers", "events", "referenceRevisions", "sessions", "subscriptions", "usageEvents"] as const)("marks %s as externally managed", (name) => {
        expect.assertions(1);

        expect(paymentExtension.tables[name]?.isExternallyManaged).toBe(true);
    });
});
