import { describe, expect, it } from "vitest";

import { articlesFor } from "../src/articles";

describe(articlesFor, () => {
    it("exports provided data on consent under both Art. 15 and Art. 20", () => {
        expect(articlesFor("provided", "consent")).toStrictEqual(["15", "20"]);
    });

    it("counts observed data on contract as portable", () => {
        expect(articlesFor("observed", "contract")).toStrictEqual(["15", "20"]);
    });

    it("keeps derived and inferred data to Art. 15 even when on contract", () => {
        expect(articlesFor("derived", "contract")).toStrictEqual(["15"]);
        expect(articlesFor("inferred", "contract")).toStrictEqual(["15"]);
    });

    it("keeps provided data processed on a legal obligation to Art. 15", () => {
        expect(articlesFor("provided", "legal_obligation")).toStrictEqual(["15"]);
    });
});
