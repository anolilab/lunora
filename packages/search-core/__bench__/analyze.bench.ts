import { bench, describe } from "vitest";

import { createSearchAnalyzer } from "../src/analyzer";
import { analyzedSearchText, countSearchTokens } from "../src/text";

/**
 * Analysis is the one part of search that runs on the *write* path: every
 * mutation to a table carrying a `.searchIndex()` re-tokenizes the covered field
 * (unless `searchTextUnchanged` short-circuits it), and every search query is
 * tokenized through the same code before it touches an index. So its cost is
 * paid per write and per query on every backend, not once per backfill.
 *
 * What the axes isolate:
 *
 * - **text size** — a chat message, a comment body, and a long-form document,
 * all ASCII. This is the shape virtually all real indexed text has, and it is
 * the case `foldText`'s ASCII fast path exists for: NFD, the diacritic strip and
 * NFC are each provably the identity on ASCII, so the pre-fast-path analyzer
 * paid three full scans and three intermediate strings to change nothing.
 * - **script** — the same byte count of accented Latin, which must take the real
 * normalization path. Benched so the fast path's guard scan is visible as a cost
 * on the input it cannot help, rather than only its win on the input it can.
 * - **stopwords** — `language: "en"` against `language: undefined`, isolating
 * the per-token set lookup from the folding.
 * - **query vs document** — `query()` additionally de-duplicates, which is
 * quadratic in the token count by design (queries are a few dozen tokens).
 */

const asciiShort = "Hello World, this is a chat message";
const asciiBody = "The quick brown fox jumps over the lazy dog. ".repeat(12);
const asciiLong = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. ".repeat(46);
const accented = "Café über größe naïve résumé Straße piñata jamón ".repeat(11);

const plain = createSearchAnalyzer(undefined);
const english = createSearchAnalyzer("en");

describe("analyzer.document — folding + tokenizing", () => {
    bench("ascii, 35 B", () => {
        plain.document(asciiShort);
    });

    bench("ascii, ~540 B (comment body)", () => {
        plain.document(asciiBody);
    });

    bench("ascii, ~4 KiB (long-form)", () => {
        plain.document(asciiLong);
    });

    bench("accented latin, ~530 B", () => {
        plain.document(accented);
    });

    bench("ascii ~540 B + en stopwords", () => {
        english.document(asciiBody);
    });
});

describe("analyzer.query — folding + tokenizing + de-dup", () => {
    bench("short query", () => {
        english.query("the quick brown fox");
    });

    bench("long query (~540 B)", () => {
        english.query(asciiBody);
    });
});

describe("write-path entry points", () => {
    const document = { body: asciiBody };
    const index = { field: "body", language: "en" };

    bench("analyzedSearchText (FTS5 shadow row)", () => {
        analyzedSearchText(document, index);
    });

    bench("countSearchTokens (inverted rows)", () => {
        countSearchTokens(asciiBody, english);
    });
});
