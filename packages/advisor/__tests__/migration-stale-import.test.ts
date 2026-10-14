import { describe, expect, it } from "vitest";

import migrationStaleImport from "../src/lints/static/migration-stale-import";
import type { LintContext } from "../src/types";

const context = (staleMigrationImports?: LintContext["staleMigrationImports"]): LintContext => {
    return { schema: { tables: [] }, staleMigrationImports };
};

describe("migration_stale_import", () => {
    it("finds nothing without feeder evidence, so a runtime caller stays quiet", () => {
        expect.assertions(1);

        expect(migrationStaleImport.run(context())).toStrictEqual([]);
    });

    it.each([
        ["convex", "convex/server", "from-convex"],
        ["supabase", "@supabase/supabase-js", "from-supabase"],
        ["firebase", "firebase/firestore", "from-firebase"],
    ] as const)("flags a stale %s import and names its guide", (platform, moduleSpecifier, guide) => {
        expect.assertions(3);

        const findings = migrationStaleImport.run(context([{ file: "messages", line: 3, moduleSpecifier, platform }]));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain(moduleSpecifier);
        expect(findings[0]?.detail).toContain(guide);
    });

    it("reports every stale import, not just the first", () => {
        expect.assertions(1);

        const findings = migrationStaleImport.run(
            context([
                { file: "a", line: 1, moduleSpecifier: "@supabase/supabase-js", platform: "supabase" },
                { file: "b", line: 2, moduleSpecifier: "firebase/app", platform: "firebase" },
            ]),
        );

        expect(findings).toHaveLength(2);
    });
});
