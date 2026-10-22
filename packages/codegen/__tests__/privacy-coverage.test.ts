import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkCoverage, classifyTables } from "../../../shared/privacy-coverage";
import readPackageDependencies from "../src/discover/package-dependencies";
import { discoverPrivacyCoverage } from "../src/discover/privacy-coverage";
import { runCodegen } from "../src/index";

/**
 * Plan 468 WS H: `privacy_table_unclassified`. A table with a `userId` column must be covered by a dataset
 * or excluded with a reason, or the build fails. The lint runs only for an app that declares `@lunora/privacy`.
 */

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), userId: v.string() }),
});
`;

const PRIVACY_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    privacy_foo: defineTable({ body: v.string(), userId: v.string() }),
});
`;

interface AppOptions {
    /** Whether the app's package.json declares `@lunora/privacy`. Defaults to true. */
    readonly declaresPackage?: boolean;
    /** Extra files, keyed by their path relative to `lunora/`. */
    readonly files?: Readonly<Record<string, string>>;
    /** The schema the app declares. Defaults to a single `notes` table with a `userId` column. */
    readonly schema?: string;
}

/** Write a minimal app: a manifest, a schema, and any extra `lunora/` files. */
const writeApp = ({ declaresPackage = true, files = {}, schema = SCHEMA }: AppOptions = {}): void => {
    const dependencies = declaresPackage ? { "@lunora/privacy": "1.0.0" } : {};

    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies, name: "app", private: true }));
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), schema);

    for (const [path, content] of Object.entries(files)) {
        const full = join(workdir, "lunora", path);

        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
    }
};

const generate = (): void => {
    runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });
};

/** The `notesData` declaration, shared by fixtures that need `notes` covered. */
const COVERED_DATASET_BODY = `export const notesData = defineDataset("notes", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Notes the user wrote",
    tables: { notes: {} },
});
`;

/** A `privacy.ts` that declares one dataset over `notes` and passes it to `definePrivacy`. */
const COVERED_PRIVACY = `import { defineDataset, definePrivacy } from "@lunora/privacy";

export const notesData = defineDataset("notes", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Notes the user wrote",
    tables: { notes: {} },
});

export const privacy = definePrivacy({ datasets: [notesData] });
`;

describe("the privacy coverage lint", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-privacy-coverage-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("does not check an app that does not use the privacy package", () => {
        expect.assertions(1);

        writeApp({ declaresPackage: true });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("does not check an app without the dependency, even when a privacy file declares definePrivacy", () => {
        expect.assertions(1);

        writeApp({
            declaresPackage: false,
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("parses no extra files for an app without the dependency, and loads them for one that declares it", () => {
        expect.assertions(2);

        const privacyFile = join(workdir, "lunora", "privacy.ts");
        const privacyContent = `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n`;

        writeApp({ declaresPackage: false, files: { "privacy.ts": privacyContent } });

        const withoutDependency = new Project({ skipAddingFilesFromTsConfig: true });

        discoverPrivacyCoverage(withoutDependency, join(workdir, "lunora"), readPackageDependencies(workdir));

        expect(withoutDependency.getSourceFile(privacyFile)).toBeUndefined();

        writeApp({ declaresPackage: true, files: { "privacy.ts": privacyContent } });

        const withDependency = new Project({ skipAddingFilesFromTsConfig: true });

        discoverPrivacyCoverage(withDependency, join(workdir, "lunora"), readPackageDependencies(workdir));

        expect(withDependency.getSourceFile(privacyFile)).toBeDefined();
    });

    it("ignores a lunora file under __tests__", () => {
        expect.assertions(1);

        // The app's real privacy file is clean. The test-folder file would fail the lint (an unused dataset) if it were read.
        writeApp({
            files: {
                "privacy.ts": COVERED_PRIVACY,
                "__tests__/privacy.ts": `import { defineDataset } from "@lunora/privacy";\n\nexport const fixture = defineDataset("fixture", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Test-only fixture",\n    tables: {},\n});\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("fails the build when the app uses the package and a table with user data is covered by no dataset", () => {
        expect.assertions(1);

        writeApp({ files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` } });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("classifies a table by a v.id of the users table even when its owner column has another name", () => {
        expect.assertions(1);

        writeApp({
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), author: v.optional(v.id("users")) }),
});
`,
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("leaves a table alone when its v.id names a table that is not a user table", () => {
        expect.assertions(1);

        writeApp({
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    tags: defineTable({ label: v.string(), postId: v.id("posts") }),
});
`,
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("classifies a v.id of a renamed auth user table as user data", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `import { authDataset, definePrivacy } from "@lunora/privacy";\n\nexport const auth = authDataset({ user: "people" });\n\nexport const privacy = definePrivacy({ datasets: [auth] });\n`,
            },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), author: v.optional(v.id("people")) }),
});
`,
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("classifies a table by a nullable v.id of the users table, a union with v.null()", () => {
        expect.assertions(1);

        writeApp({
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), author: v.union(v.id("users"), v.null()) }),
});
`,
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("classifies a table by a v.id of the users table nested in a v.object column", () => {
        expect.assertions(1);

        writeApp({
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), meta: v.object({ owner: v.id("users") }) }),
});
`,
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("checks a table whose name starts with privacy_", () => {
        expect.assertions(1);

        writeApp({
            files: { "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n` },
            schema: PRIVACY_SCHEMA,
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "privacy_foo"/u);
    });

    it("passes when a defineDataset lists the table and definePrivacy passes the dataset", () => {
        expect.assertions(1);

        writeApp({ files: { "privacy.ts": COVERED_PRIVACY } });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("passes when definePrivacy excludes the table with a reason", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({\n    datasets: [],\n    exclude: { notes: "Operator-owned audit trail; no personal data after redaction" },\n});\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("refuses an exclusion with no reason", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({\n    datasets: [],\n    exclude: { notes: "" },\n});\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_exclusion_unexplained: "notes" is excluded without a reason/u);
    });

    it("treats a renamed auth dataset as covering the table names it was given", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `import { authDataset, definePrivacy } from "@lunora/privacy";\n\nexport const auth = authDataset({ user: "notes" });\n\nexport const privacy = definePrivacy({ datasets: [auth] });\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("reports a defineDataset that no definePrivacy passes, when the datasets literal resolves", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `${COVERED_PRIVACY}\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Never passed",\n    tables: {},\n});\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "orphanData"/u);
    });

    it("reports a dataset left out of a config that definePrivacy spreads", () => {
        expect.assertions(1);

        // The config carries only notesData, so billingData is erased by nothing.
        writeApp({
            files: {
                "privacy.ts": `import { defineDataset, definePrivacy } from "@lunora/privacy";\n\n${COVERED_DATASET_BODY}\nexport const billingData = defineDataset("billing", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Invoices",\n    tables: {},\n});\n\nexport const privacyConfig = { datasets: [notesData] };\n\nexport const privacy = definePrivacy({ ...privacyConfig, ports: () => undefined });\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "billingData"/u);
    });

    it("follows a shorthand datasets property to its array", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "privacy.ts": `import { defineDataset, definePrivacy } from "@lunora/privacy";\n\n${COVERED_DATASET_BODY}\nexport const billingData = defineDataset("billing", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Invoices",\n    tables: {},\n});\n\nconst datasets = [notesData];\n\nexport const privacy = definePrivacy({ datasets, ports: () => undefined });\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "billingData"/u);
    });

    it("passes when a spread config, declared in another lunora file, carries every dataset and the exclusions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        writeApp({
            files: {
                "config.ts": `import { defineDataset } from "@lunora/privacy";\n\n${COVERED_DATASET_BODY}\nexport const privacyConfig = { datasets: [notesData], exclude: { audit: "Kept for the legal hold" } } as const;\n`,
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nimport { privacyConfig } from "./config";\n\nexport const privacy = definePrivacy({ ...privacyConfig, ports: () => undefined });\n`,
            },
            schema: `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({\n    audit: defineTable({ userId: v.string() }),\n    notes: defineTable({ body: v.string(), userId: v.string() }),\n});\n`,
        });

        expect(() => {
            generate();
        }).not.toThrow();

        const warnings = warn.mock.calls.map((call) => String(call[0]));

        warn.mockRestore();

        expect(warnings.filter((message) => message.includes("privacy_datasets_unresolved"))).toStrictEqual([]);
    });

    it("warns instead of staying silent when definePrivacy spreads a config codegen cannot read", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        writeApp({
            files: {
                "privacy.ts": `import { defineDataset, definePrivacy } from "@lunora/privacy";\n\n${COVERED_DATASET_BODY}\nconst makeConfig = () => { return { datasets: [notesData] }; };\n\nexport const privacy = definePrivacy({ ...makeConfig(), exclude: {}, ports: () => undefined });\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();

        const warnings = warn.mock.calls.map((call) => String(call[0]));

        warn.mockRestore();

        expect(warnings.filter((message) => message.includes("privacy_datasets_unresolved: the definePrivacy call at"))).toHaveLength(1);
    });

    it("resolves a dataset passed by an import from another lunora file", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "datasets.ts": `import { defineDataset } from "@lunora/privacy";\n\nexport const notesData = defineDataset("notes", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Notes the user wrote",\n    tables: { notes: {} },\n});\n\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Never passed",\n    tables: {},\n});\n`,
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nimport { notesData } from "./datasets";\n\nexport const privacy = definePrivacy({ datasets: [notesData] });\n`,
            },
        });

        // Throwing about orphanData shows the alias resolved (otherwise the literal is unresolvable and nothing is
        // reported) and that the imported notesData matched by identity (otherwise it would be reported too).
        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "orphanData"/u);
    });

    it("resolves an imported datasets value passed as a shorthand property", () => {
        expect.assertions(1);

        // `{ datasets }` with `datasets` imported is an alias, which must be followed to its initializer.
        writeApp({
            files: {
                "config.ts": `import { defineDataset } from "@lunora/privacy";\n\nexport const notesData = defineDataset("notes", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Notes the user wrote",\n    tables: { notes: {} },\n});\n\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Never passed",\n    tables: {},\n});\n\nexport const datasets = [notesData];\n`,
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nimport { datasets } from "./config";\n\nexport const privacy = definePrivacy({ datasets });\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "orphanData"/u);
    });

    it("refuses an exclusion with a blank reason even when a dataset also covers the table", () => {
        expect.assertions(1);

        // definePrivacy lets an exclusion overwrite a dataset, so the blank reason is what counts at runtime.
        writeApp({
            files: {
                "privacy.ts": `import { defineDataset, definePrivacy } from "@lunora/privacy";\n\nexport const notesData = defineDataset("notes", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Notes the user wrote",\n    tables: { notes: {} },\n});\n\nexport const privacy = definePrivacy({\n    datasets: [notesData],\n    exclude: { notes: "" },\n});\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_exclusion_unexplained: "notes" is excluded without a reason/u);
    });

    it("treats an inline or variable-bound built-in dataset as passed, so an orphan beside it is still reported", () => {
        expect.assertions(1);

        // notesData covers the user table, so the coverage check passes and only the orphan can fail the build.
        writeApp({
            files: {
                "privacy.ts": `import { authDataset, defineDataset, definePrivacy } from "@lunora/privacy";\n\n${COVERED_DATASET_BODY}\nexport const auth = authDataset();\n\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Never passed",\n    tables: {},\n});\n\nexport const privacy = definePrivacy({ datasets: [authDataset(), auth, notesData] });\n`,
            },
        });

        expect(() => {
            generate();
        }).toThrow(/privacy_dataset_unused: "orphanData"/u);
    });

    it("does not report an unused dataset when the datasets literal cannot be resolved, and warns", () => {
        expect.assertions(2);

        // An opaque spread element could carry the dataset that looks unused, so the lint reports nothing and warns.
        writeApp({
            files: {
                "privacy.ts": `${COVERED_PRIVACY}\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Possibly passed through a spread",\n    tables: {},\n});\n\nconst extra = () => [orphanData];\nexport const more = definePrivacy({ datasets: [notesData, ...extra()] });\n`,
            },
        });

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(() => {
            generate();
        }).not.toThrow();

        const warnings = warn.mock.calls.map((call) => String(call[0]));

        warn.mockRestore();

        expect(warnings.some((message) => message.includes("privacy_datasets_unresolved"))).toBe(true);
    });
});

describe("checkCoverage", () => {
    it("reports an unlisted table as unclassified and accepts a dataset or a reasoned exclusion", () => {
        expect.assertions(1);

        const classifications = classifyTables([["tasks", "tasks"]], [["featureFlags", "Operator configuration; no personal data"]]);

        expect(checkCoverage(["tasks", "featureFlags", "notes"], classifications)).toStrictEqual([{ code: "unclassified", table: "notes" }]);
    });

    it("reports a blank exclusion reason under its own code, even over a dataset", () => {
        expect.assertions(1);

        const classifications = classifyTables([["flags", "flags"]], [["flags", "   "]]);

        expect(checkCoverage(["flags"], classifications)).toStrictEqual([{ code: "excluded_without_reason", table: "flags" }]);
    });
});
