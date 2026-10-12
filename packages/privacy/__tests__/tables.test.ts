import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { privacyExtension } from "../src/index";

const LIFECYCLE_SOURCE = new URL("../src/lifecycle.ts", import.meta.url);
const TABLES_SOURCE = new URL("../src/tables.ts", import.meta.url);
const STATUS_UNION = /type RequestStatus = ([^;]+);/u;
const QUOTED_WORD = /"([a-z]+)"/gu;
const LITERAL_WORD = /v\.literal\("([a-z]+)"\)/gu;

describe("privacyExtension", () => {
    it("is keyed privacy so every table is prefixed privacy_", () => {
        expect(privacyExtension.key).toBe("privacy");
    });

    it("declares the five tables the lifecycle and the archive need", () => {
        expect(Object.keys(privacyExtension.tables).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "archive",
            "events",
            "holds",
            "requests",
            "tombstones",
        ]);
    });

    it("accepts every status the lifecycle can write to the requests table", () => {
        expect.assertions(1);

        const lifecycle = STATUS_UNION.exec(readFileSync(LIFECYCLE_SOURCE, "utf8"))?.[1] ?? "";
        const statuses = [...lifecycle.matchAll(QUOTED_WORD)].map((m) => m[1] ?? "");
        const tables = readFileSync(TABLES_SOURCE, "utf8");
        const columnStart = tables.indexOf("status: v.union(");
        const literals = [...tables.slice(columnStart, tables.indexOf("storageKey", columnStart)).matchAll(LITERAL_WORD)].map((m) => m[1] ?? "");

        expect(literals.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(statuses.toSorted((a, b) => a.localeCompare(b)));
    });
});
