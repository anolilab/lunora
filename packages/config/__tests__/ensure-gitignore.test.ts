import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ensureGitignoreEntries from "../src/ensure-gitignore";

/** Runs once right after the helper reads a `.gitignore`, standing in for another process editing it then. */
let afterGitignoreRead: (() => void) | undefined;

vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        readFileSync: ((...arguments_: Parameters<typeof actual.readFileSync>) => {
            const result = actual.readFileSync(...arguments_);
            const hook = afterGitignoreRead;

            if (hook !== undefined && String(arguments_[0]).endsWith(".gitignore")) {
                afterGitignoreRead = undefined;
                hook();
            }

            return result;
        }) as typeof actual.readFileSync,
    };
});

const PATTERNS = [".celld/", ".celld.wrangler.json", ".celld.service.*.wrangler.json"];
const DEV_VARS = [".dev.vars", ".dev.vars.*", "!.dev.vars.example"];

describe("ensureGitignoreEntries", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-gitignore-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    const read = (): string => readFileSync(join(directory, ".gitignore"), "utf8");

    it("creates the file with every pattern when there is none", () => {
        expect.hasAssertions();

        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual(PATTERNS);
        expect(read().split("\n")).toEqual(expect.arrayContaining(PATTERNS));
    });

    it("keeps an edit another process made between the read and the write", () => {
        expect.hasAssertions();

        writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
        afterGitignoreRead = () => {
            writeFileSync(join(directory, ".gitignore"), "node_modules/\ndist/\n");
        };

        ensureGitignoreEntries(directory, PATTERNS);

        expect(read().split("\n")).toEqual(expect.arrayContaining(["node_modules/", "dist/", ...PATTERNS]));
    });

    it("is idempotent: a second call appends nothing and leaves the file byte-identical", () => {
        expect.hasAssertions();

        ensureGitignoreEntries(directory, PATTERNS);
        const once = read();

        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual([]);
        expect(read()).toBe(once);
    });

    it("appends only the missing patterns and keeps existing lines", () => {
        expect.hasAssertions();

        writeFileSync(join(directory, ".gitignore"), "node_modules\r\n.celld/\r\n", "utf8");

        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual([".celld.wrangler.json", ".celld.service.*.wrangler.json"]);
        expect(read().startsWith("node_modules\r\n.celld/\r\n")).toBe(true);
        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual([]);
    });

    it("re-appends a present pattern a later negation would re-include", () => {
        expect.hasAssertions();

        writeFileSync(
            join(directory, ".gitignore"),
            ".celld/\n.celld.wrangler.json\n.celld.service.*.wrangler.json\n!.celld.service.parser.wrangler.json\n",
            "utf8",
        );

        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual(PATTERNS);

        const lines = read().split("\n");

        expect(lines.lastIndexOf(".celld.service.*.wrangler.json")).toBeGreaterThan(lines.indexOf("!.celld.service.parser.wrangler.json"));
        expect(ensureGitignoreEntries(directory, PATTERNS)).toEqual([]);
    });

    it("re-states the negations after the additions, so the example file stays visible", () => {
        expect.hasAssertions();

        writeFileSync(join(directory, ".gitignore"), ".dev.vars\n!.dev.vars.example\n", "utf8");

        ensureGitignoreEntries(directory, DEV_VARS);
        const lines = read().split(/\r?\n/u);

        expect(lines.indexOf(".dev.vars.*")).toBeLessThan(lines.lastIndexOf("!.dev.vars.example"));
        expect(ensureGitignoreEntries(directory, DEV_VARS)).toEqual([]);
    });
});
