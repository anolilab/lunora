import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Repo root, three levels up from packages/runtime/__tests__.
const REPO_ROOT = join(__dirname, "..", "..", "..");

const CANONICAL_FILE = "shared/constant-time-equal.ts";

// Known pre-existing copy, tracked as a deliberate follow-up (plan 230,
// SHARED-01) rather than fixed here — payment webhook verification predates
// the canonical `shared/constant-time-equal.ts` and is out of scope for this
// change. Do not add further entries: any *new* local redeclaration should
// fail this test and import the canonical helper instead.
const KNOWN_COPIES = new Set(["packages/payment/src/webhook.ts"]);

const SKIP_DIRECTORIES = new Set([".git", ".history", ".vis", ".wrangler", "__fixtures__", "coverage", "dist", "fixtures", "node_modules", "test-results"]);

const DECLARATION_PATTERN = /(?:const|function)\s+constantTimeEqual\s*[=(]/;

/** Recursively collect `.ts`/`.tsx` source files under `dir`, skipping build/vendor directories. */
const collectSourceFiles = (dir: string): string[] => {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        if (SKIP_DIRECTORIES.has(entry)) {
            continue;
        }

        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);

        /* eslint-disable vitest/no-conditional-tests -- filesystem walk, not a test-behavior branch; the file-type check is inherent to recursing a directory tree */
        if (stats.isDirectory()) {
            files.push(...collectSourceFiles(fullPath));
        } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
            files.push(fullPath);
        }
        /* eslint-enable vitest/no-conditional-tests */
    }

    return files;
};

describe("constantTimeEqual dedup guard", () => {
    it("has exactly one canonical definition, plus only the documented known copies", () => {
        expect.assertions(1);

        const sourceRoots = ["shared", "packages"].map((directory) => join(REPO_ROOT, directory));
        const offenders: string[] = [];

        for (const root of sourceRoots) {
            for (const filePath of collectSourceFiles(root)) {
                const relativePath = relative(REPO_ROOT, filePath).split("\\").join("/");

                if (relativePath === CANONICAL_FILE || KNOWN_COPIES.has(relativePath)) {
                    continue;
                }

                if (relativePath.includes("/__tests__/") || relativePath.includes("/__fixtures__/")) {
                    continue;
                }

                const content = readFileSync(filePath, "utf8");

                if (DECLARATION_PATTERN.test(content)) {
                    offenders.push(relativePath);
                }
            }
        }

        expect(
            offenders,
            'Found a local `constantTimeEqual` declaration outside the canonical shared/ file and the documented known copies. Import { constantTimeEqual } from "shared/constant-time-equal" instead of redeclaring it.',
        ).toStrictEqual([]);
    });
});
