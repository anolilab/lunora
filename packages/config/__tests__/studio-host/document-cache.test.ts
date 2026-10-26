import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import createStudioDocumentCache from "../../src/studio-host/document-cache";

describe(createStudioDocumentCache, () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-document-cache-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("renders once while .dev.vars is unchanged", () => {
        expect.assertions(2);

        writeFileSync(join(root, ".dev.vars"), "LUNORA_ADMIN_TOKEN=one\n");

        let renders = 0;
        const current = createStudioDocumentCache(root, () => {
            renders += 1;

            return `doc-${String(renders)}`;
        });

        current();
        current();

        expect(current()).toBe("doc-1");
        expect(renders).toBe(1);
    });

    it("re-renders once .dev.vars is created", () => {
        expect.assertions(2);

        let renders = 0;
        const current = createStudioDocumentCache(root, () => {
            renders += 1;

            return `doc-${String(renders)}`;
        });

        expect(current()).toBe("doc-1");

        writeFileSync(join(root, ".dev.vars"), "LUNORA_ADMIN_TOKEN=one\n");

        expect(current()).toBe("doc-2");
    });

    it("stamps before rendering, so a write made during the render is picked up on the next call", () => {
        expect.assertions(2);

        const path = join(root, ".dev.vars");

        writeFileSync(path, "LUNORA_ADMIN_TOKEN=one\n");

        let renders = 0;
        const current = createStudioDocumentCache(root, () => {
            renders += 1;

            // A rotation landing after the stamp was taken; appending changes the size, so the stamp moves whatever the ctime resolution.
            if (renders === 1) {
                appendFileSync(path, "LUNORA_ADMIN_TOKEN=two\n");
            }

            return `doc-${String(renders)}`;
        });

        expect(current()).toBe("doc-1");
        expect(current()).toBe("doc-2");
    });
});
