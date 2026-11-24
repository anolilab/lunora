import { describe, expect, it } from "vitest";

import { agentExtension } from "../src/component";

// The agent component writes these tables from its own functions, through `context.db` with a table name held in a constant. The
// installing app's advisor does not scan the package, so each table must declare that write path, or `table_without_insert` fires.
describe("agent tables declare their write path", () => {
    it.each(["approval_grants", "messages", "run_queue", "secret_requests", "threads"] as const)("marks %s as externally managed", (name) => {
        expect.assertions(1);

        expect(agentExtension.tables[name]?.isExternallyManaged).toBe(true);
    });
});
