import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

/**
 * Plan 468 WS H: `privacy_table_unclassified`. A table with a `userId` column must
 * be covered by a dataset or excluded with a reason, or the build fails.
 */

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    notes: defineTable({ body: v.string(), userId: v.string() }),
});
`;

/** A minimal app: a schema, and the privacy file the test writes. */
const writeApp = (privacyFile: string | undefined): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA);

    if (privacyFile !== undefined) {
        writeFileSync(join(workdir, "lunora", "privacy.ts"), privacyFile);
    }
};

const generate = (): void => {
    runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });
};

describe("the privacy coverage lint", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-privacy-coverage-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("does not check an app that does not use the privacy package", () => {
        expect.assertions(1);

        writeApp(undefined);

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("fails the build when the app uses the package and a table with user data is covered by no dataset", () => {
        expect.assertions(1);

        writeApp(`import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({ datasets: [] });\n`);

        expect(() => {
            generate();
        }).toThrow(/privacy_table_unclassified: "notes"/u);
    });

    it("passes when a defineDataset lists the table", () => {
        expect.assertions(1);

        writeApp(
            `import { defineDataset } from "@lunora/privacy";\n\nexport const notesData = defineDataset("notes", {\n    legalBasis: "contract",\n    origin: "provided",\n    purpose: "Notes the user wrote",\n    tables: { notes: {} },\n});\n`,
        );

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("passes when definePrivacy excludes the table with a reason", () => {
        expect.assertions(1);

        writeApp(
            `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({\n    datasets: [],\n    exclude: { notes: "Operator-owned audit trail; no personal data after redaction" },\n});\n`,
        );

        expect(() => {
            generate();
        }).not.toThrow();
    });

    it("refuses an exclusion with no reason", () => {
        expect.assertions(1);

        writeApp(
            `import { definePrivacy } from "@lunora/privacy";\n\nexport const privacy = definePrivacy({\n    datasets: [],\n    exclude: { notes: "" },\n});\n`,
        );

        expect(() => {
            generate();
        }).toThrow(/excluded without a reason/u);
    });

    it("treats a renamed auth dataset as covering the table names it was given", () => {
        expect.assertions(1);

        writeApp(`import { authDataset } from "@lunora/privacy";\n\nexport const auth = authDataset({ user: "notes" });\n`);

        expect(() => {
            generate();
        }).not.toThrow();
    });
});
