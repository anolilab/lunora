import { describe, expect, it } from "vitest";

import type { SqlSchema } from "../../../src/features/sql/sql-autocomplete";
import { acceptSuggestion, suggestionsFor, tokenAt } from "../../../src/features/sql/sql-autocomplete";

const SCHEMA: SqlSchema = {
    columns: { messages: ["id", "author", "body", "_creationTime"], users: ["id", "email"] },
    tables: ["messages", "users"],
};

describe("sqlAutocomplete", () => {
    describe("tokenAt", () => {
        it("returns the identifier the caret sits at the end of", () => {
            expect.assertions(1);

            expect(tokenAt("SELECT * FROM mess", 18)).toStrictEqual({ end: 18, start: 14, text: "mess" });
        });

        it("returns a zero-width span after whitespace/punctuation", () => {
            expect.assertions(1);

            expect(tokenAt("SELECT * FROM ", 14)).toStrictEqual({ end: 14, start: 14, text: "" });
        });
    });

    describe("suggestionsFor", () => {
        it("suggests a table name from its prefix after FROM", () => {
            expect.assertions(2);

            const value = "SELECT * FROM mess";
            const hits = suggestionsFor(value, value.length, SCHEMA);

            expect(hits[0]).toStrictEqual({ kind: "table", label: "messages" });
            expect(hits.some((hit) => hit.kind === "table" && hit.label === "messages")).toBe(true);
        });

        it("suggests a column from its prefix, leading after SELECT", () => {
            expect.assertions(2);

            const value = "SELECT au";
            const hits = suggestionsFor(value, value.length, SCHEMA);

            expect(hits[0]).toStrictEqual({ detail: "messages", kind: "column", label: "author" });
            expect(hits.every((hit) => hit.kind !== "table")).toBe(true);
        });

        it("restricts to one table's columns behind a `tbl.` qualifier", () => {
            expect.assertions(2);

            const value = "SELECT messages.";
            const hits = suggestionsFor(value, value.length, SCHEMA);

            expect(hits.map((hit) => hit.label)).toStrictEqual(["id", "author", "body", "_creationTime"]);
            expect(hits.every((hit) => hit.detail === "messages")).toBe(true);
        });

        it("offers nothing for an empty token outside a column-reading clause", () => {
            expect.assertions(1);

            expect(suggestionsFor("SELECT * FROM ", 14, SCHEMA)).toHaveLength(0);
        });

        it("suppresses a keyword that the typed token already spells in full", () => {
            expect.assertions(1);

            const value = "SELECT";
            const hits = suggestionsFor(value, value.length, SCHEMA);

            expect(hits.some((hit) => hit.kind === "keyword" && hit.label === "SELECT")).toBe(false);
        });
    });

    describe("acceptSuggestion", () => {
        it("splices the chosen label over the caret's token and advances the caret", () => {
            expect.assertions(1);

            const value = "SELECT * FROM mess";

            expect(acceptSuggestion(value, value.length, { kind: "table", label: "messages" })).toStrictEqual({
                caret: 22,
                value: "SELECT * FROM messages",
            });
        });
    });
});
