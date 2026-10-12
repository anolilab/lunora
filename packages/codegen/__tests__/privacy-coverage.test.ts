import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCoverage as packageCheckCoverage } from "../../privacy/src/coverage";
import readPackageDependencies from "../src/discover/package-dependencies";
import { checkPrivacyCoverage, discoverPrivacyCoverage } from "../src/discover/privacy-coverage";
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
        }).toThrow(/excluded without a reason/u);
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

    it("resolves a dataset passed by an import from another lunora file", () => {
        expect.assertions(1);

        writeApp({
            files: {
                "datasets.ts": `import { defineDataset } from "@lunora/privacy";\n\nexport const notesData = defineDataset("notes", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Notes the user wrote",\n    tables: { notes: {} },\n});\n`,
                "privacy.ts": `import { definePrivacy } from "@lunora/privacy";\n\nimport { notesData } from "./datasets";\n\nexport const privacy = definePrivacy({ datasets: [notesData] });\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();
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
        }).toThrow(/excluded without a reason/u);
    });

    it("does not report an unused dataset when the datasets literal cannot be resolved", () => {
        expect.assertions(1);

        // A spread element could carry the dataset that looks unused, so the lint must stay silent.
        writeApp({
            files: {
                "privacy.ts": `${COVERED_PRIVACY}\nexport const orphanData = defineDataset("orphan", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Possibly passed through a spread",\n    tables: {},\n});\n\nexport const extra = [orphanData];\nexport const more = definePrivacy({ datasets: [notesData, ...extra] });\n`,
            },
        });

        expect(() => {
            generate();
        }).not.toThrow();
    });
});

describe("checkPrivacyCoverage", () => {
    it("agrees with the privacy package's checkCoverage on the same fixtures", () => {
        expect.assertions(3);

        const fixtures: ReadonlyArray<{
            classifications: Record<string, { dataset?: string; excluded?: string } | undefined>;
            tables: ReadonlyArray<string>;
        }> = [
            {
                classifications: {
                    featureFlags: { excluded: "Operator configuration; no personal data" },
                    goals: { dataset: "tasks" },
                    tasks: { dataset: "tasks" },
                },
                tables: ["tasks", "goals", "featureFlags"],
            },
            { classifications: { tasks: { dataset: "tasks" } }, tables: ["tasks", "notes"] },
            { classifications: { flags: { excluded: "   " } }, tables: ["flags"] },
        ];

        for (const { classifications, tables } of fixtures) {
            expect(checkPrivacyCoverage(tables, classifications)).toStrictEqual(packageCheckCoverage(tables, classifications));
        }
    });
});
