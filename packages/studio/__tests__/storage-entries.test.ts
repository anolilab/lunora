import type { StorageObject } from "@cirrus/client";
import { describe, expect, it } from "vitest";

import { DEFAULT_SHARE_LIFETIME, deriveEntries, fileSortValue, SHARE_LIFETIMES, sortFiles } from "../src/storage-entries";

const object = (key: string, extra: Partial<StorageObject> = {}): StorageObject => {
    return { etag: `e-${key}`, key, size: 0, ...extra };
};

describe("deriveEntries", () => {
    it("splits a flat listing into files and immediate folders", () => {
        expect.assertions(2);

        const { files, folders } = deriveEntries([object("docs/readme.md"), object("images/logo.png"), object("root.txt")], "");

        expect(folders).toStrictEqual(["docs/", "images/"]);
        expect(files.map((f) => f.key)).toStrictEqual(["root.txt"]);
    });

    it("derives entries relative to a deep prefix (deep nesting)", () => {
        expect.assertions(2);

        const objects = [object("docs/guide/intro.md"), object("docs/guide/setup.md"), object("docs/readme.md")];
        const { files, folders } = deriveEntries(objects, "docs/");

        // Under docs/: a guide/ sub-folder + the readme file at this level.
        expect(folders).toStrictEqual(["guide/"]);
        expect(files.map((f) => f.key)).toStrictEqual(["docs/readme.md"]);
    });

    it("de-dupes folders that appear across many keys", () => {
        expect.assertions(1);

        const { folders } = deriveEntries([object("a/1.txt"), object("a/2.txt"), object("a/3.txt")], "");

        expect(folders).toStrictEqual(["a/"]);
    });

    it("treats a key equal to the prefix as a (empty-named) file, not a folder", () => {
        expect.assertions(2);

        const { files, folders } = deriveEntries([object("docs/")], "docs/");

        expect(folders).toStrictEqual([]);
        expect(files.map((f) => f.key)).toStrictEqual(["docs/"]);
    });
});

describe("fileSortValue", () => {
    it("returns the numeric size for the size key", () => {
        expect.assertions(1);

        expect(fileSortValue(object("a", { size: 42 }), "size")).toBe(42);
    });

    it("parses a date key as a number from both epoch-ms and ISO strings", () => {
        expect.assertions(2);

        const iso = fileSortValue(object("a", { uploaded: "2020-01-01T00:00:00.000Z" }), "date");
        const ms = fileSortValue(object("b", { uploaded: new Date("2020-01-01T00:00:00.000Z").getTime() }), "date");

        expect(iso).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
        expect(ms).toBe(iso);
    });

    it("guards an unparseable date to 0 (no NaN)", () => {
        expect.assertions(2);

        const value = fileSortValue(object("a", { uploaded: "not-a-date" }), "date");

        expect(value).toBe(0);
        expect(Number.isNaN(value)).toBe(false);
    });

    it("reads a customMetadata tag for a tag: key", () => {
        expect.assertions(2);

        expect(fileSortValue(object("a", { customMetadata: { color: "red" } }), "tag:color")).toBe("red");
        expect(fileSortValue(object("a"), "tag:missing")).toBe("");
    });

    it("falls back to the key for the name key", () => {
        expect.assertions(1);

        expect(fileSortValue(object("z.txt"), "name")).toBe("z.txt");
    });
});

describe("sortFiles", () => {
    it("sorts numerically by size ascending and descending", () => {
        expect.assertions(2);

        const files = [object("big", { size: 100 }), object("small", { size: 1 }), object("mid", { size: 10 })];

        expect(sortFiles(files, "size", "asc").map((f) => f.key)).toStrictEqual(["small", "mid", "big"]);
        expect(sortFiles(files, "size", "desc").map((f) => f.key)).toStrictEqual(["big", "mid", "small"]);
    });

    it("orders a bad date last/first deterministically (NaN guarded to 0)", () => {
        expect.assertions(1);

        const files = [object("bad", { uploaded: "nope" }), object("good", { uploaded: "2020-01-01T00:00:00.000Z" })];

        // bad → 0, good → a positive epoch, so ascending puts the bad one first.
        expect(sortFiles(files, "date", "asc").map((f) => f.key)).toStrictEqual(["bad", "good"]);
    });

    it("sorts by a customMetadata tag as a locale string", () => {
        expect.assertions(1);

        const files = [
            object("c", { customMetadata: { rank: "c" } }),
            object("a", { customMetadata: { rank: "a" } }),
            object("b", { customMetadata: { rank: "b" } }),
        ];

        expect(sortFiles(files, "tag:rank", "asc").map((f) => f.key)).toStrictEqual(["a", "b", "c"]);
    });

    it("does not mutate the input array", () => {
        expect.assertions(1);

        const files = [object("b", { size: 2 }), object("a", { size: 1 })];

        sortFiles(files, "size", "asc");

        expect(files.map((f) => f.key)).toStrictEqual(["b", "a"]);
    });
});

describe("share lifetimes", () => {
    it("exposes the offered lifetimes and a 1h default", () => {
        expect.assertions(2);

        expect(DEFAULT_SHARE_LIFETIME).toBe(3600);
        expect(SHARE_LIFETIMES.map((l) => l.seconds)).toStrictEqual([900, 3600, 86_400, 604_800]);
    });
});
