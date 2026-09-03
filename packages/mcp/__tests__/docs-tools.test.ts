import { describe, expect, it, vi } from "vitest";

import { DOCS_TOOL_DEFINITIONS, docsTools, MAX_SEARCH_LIMIT, normalizeDocUrl } from "../src/docs/tools";
import type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "../src/docs/types";
import type { ToolResult } from "../src/tool-types";

const PAGES: DocsPage[] = [
    { content: "Use `.shardBy(key)` to partition state.", description: "Partition state across DOs", title: "Sharding", url: "/docs/sharding" },
    { content: "`defineSchema` declares your tables.", title: "Schema", url: "/docs/schema" },
];

const stubIndex = (
    overrides: Partial<DocsIndex> = {},
): {
    asIndex: DocsIndex;
    getPage: ReturnType<typeof vi.fn>;
    listPages: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
} => {
    const getPage = vi.fn<(url: string) => Promise<DocsPage | undefined>>(async (url) => PAGES.find((page) => page.url === url));
    const listPages = vi.fn<() => Promise<ReadonlyArray<DocsPageSummary>>>(async () =>
        PAGES.map(({ title, url }) => {
            return { title, url };
        }),
    );
    const search = vi.fn<(query: string) => Promise<ReadonlyArray<DocsSearchHit>>>(async () => [
        { excerpt: "Use .shardBy(key)", section: "Guides › Sharding", title: "Sharding", url: "/docs/sharding" },
    ]);

    return { asIndex: { getPage, listPages, search, ...overrides }, getPage, listPages, search };
};

const textOf = (result: { content: { text: string }[] }): string => result.content.map((part) => part.text).join("");

/**
 * Invoke a tool the way `createToolServer` does — through the handler bound to
 * its advertised definition. There is no separate dispatch function to test.
 */
const call = async (index: DocsIndex, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = docsTools(index).find((entry) => entry.definition.name === name);

    if (tool === undefined) {
        throw new Error(`no docs tool named ${name}`);
    }

    return tool.handle(input);
};

describe("docs tool definitions", () => {
    it("advertises the three documentation tools", () => {
        expect.assertions(1);

        expect(DOCS_TOOL_DEFINITIONS.map((tool) => tool.name)).toStrictEqual(["lunora_search_docs", "lunora_get_doc", "lunora_list_docs"]);
    });

    it("requires a query for search and a url for get", () => {
        expect.assertions(2);

        const [search, get] = DOCS_TOOL_DEFINITIONS;

        expect(search?.inputSchema.required).toStrictEqual(["query"]);
        expect(get?.inputSchema.required).toStrictEqual(["url"]);
    });

    it("binds every definition to a handler in docsTools", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const tools = docsTools(asIndex);

        expect(tools.map((tool) => tool.definition.name)).toStrictEqual(DOCS_TOOL_DEFINITIONS.map((tool) => tool.name));

        const listed = await tools[2]?.handle({});

        expect(listed?.isError).toBeUndefined();
    });
});

describe("normalizeDocUrl", () => {
    it.each([
        ["/docs/sharding", "/docs/sharding"],
        ["docs/sharding", "/docs/sharding"],
        ["sharding", "/docs/sharding"],
        ["/docs/sharding/", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding#occ", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding?x=1", "/docs/sharding"],
        ["  /docs/sharding  ", "/docs/sharding"],
    ])("normalizes %s", (input, expected) => {
        expect.assertions(1);

        expect(normalizeDocUrl(input)).toBe(expected);
    });

    it("accepts an ordinary hyphenated slug", () => {
        expect.assertions(1);

        expect(normalizeDocUrl("/docs/durable-objects")).toBe("/docs/durable-objects");
    });

    it("folds a backslash separator into the slash the url parser would see", () => {
        expect.assertions(1);

        expect(normalizeDocUrl(String.raw`/docs\sharding`)).toBe("/docs/sharding");
    });

    it.each([
        ["a literal traversal", "/docs/../../api/search"],
        ["an encoded traversal", "/docs/%2e%2e/%2e%2e/api/search"],
        ["an upper-case encoded traversal", "/docs/%2E%2E/x"],
        ["a double-encoded traversal", "/docs/%252e%252e/x"],
        ["a single-dot segment", "/docs/./x"],
        ["an encoded slash hiding a traversal", "/docs/a%2Fb/.."],
        ["a malformed percent-escape", "/docs/100%"],
        ["a backslash traversal", String.raw`/docs/..\..\..\api/internal`],
        ["a mixed slash/backslash traversal", String.raw`/docs/..\../admin`],
        ["an encoded backslash segment", "/docs/%5c..%5cadmin"],
        // The separator itself is encoded, so the raw string has no `/` to split
        // on and the whole traversal hides inside one segment.
        ["an encoded traversal with an encoded separator", "/docs/%2e%2e%2fapi"],
        ["an encoded traversal reaching the site root", "/docs/%2e%2e%2f%2e%2e%2fapi%2fsearch"],
    ])("rejects %s", (_label, input) => {
        expect.assertions(1);

        expect(() => normalizeDocUrl(input)).toThrow(RangeError);
    });
});

describe("lunora_search_docs", () => {
    it("returns hits for a query", async () => {
        expect.assertions(3);

        const { asIndex, search } = stubIndex();
        const result = await call(asIndex, "lunora_search_docs", { query: "sharding" });

        expect(result.isError).toBeUndefined();
        expect(search).toHaveBeenCalledWith("sharding");
        expect(textOf(result)).toContain("/docs/sharding");
    });

    it.each([
        ["an over-large limit is capped", 999, MAX_SEARCH_LIMIT],
        ["a zero limit is raised to one", 0, 1],
        ["a numeric string is accepted", "3", 3],
        ["an unparseable limit falls back to the default", "nonsense", 10],
    ])("%s", async (_label, limit, expected) => {
        expect.assertions(1);

        const { asIndex } = stubIndex({
            search: vi.fn<DocsIndex["search"]>(async () =>
                Array.from({ length: 200 }, (_unused, index) => {
                    return { title: `t${String(index)}`, url: `/docs/${String(index)}` };
                }),
            ),
        });

        const parsed = JSON.parse(textOf(await call(asIndex, "lunora_search_docs", { limit, query: "a" }))) as { hits: unknown[] };

        expect(parsed.hits).toHaveLength(expected);
    });

    it("truncates a backend that returns more than the limit", async () => {
        expect.assertions(1);

        const { asIndex } = stubIndex({
            search: vi.fn<DocsIndex["search"]>(async () =>
                Array.from({ length: 5 }, (_, index) => {
                    return { title: `t${String(index)}`, url: `/docs/${String(index)}` };
                }),
            ),
        });

        const result = await call(asIndex, "lunora_search_docs", { limit: 2, query: "a" });
        const parsed = JSON.parse(textOf(result)) as { hits: unknown[] };

        expect(parsed.hits).toHaveLength(2);
    });

    it("suggests a next step when nothing matches", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex({ search: vi.fn<DocsIndex["search"]>(async () => []) });
        const result = await call(asIndex, "lunora_search_docs", { query: "zzz" });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toContain("lunora_list_docs");
    });

    it("rejects a missing or blank query, naming the argument", async () => {
        expect.assertions(5);

        const { asIndex, search } = stubIndex();

        for (const input of [{}, { query: "" }, { query: "   " }, { query: 42 }]) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: each input must be rejected on its own
            await expect(call(asIndex, "lunora_search_docs", input)).rejects.toThrow(/"query"/);
        }

        expect(search).not.toHaveBeenCalled();
    });

    it("lets a backend failure propagate for the server to convert", async () => {
        expect.assertions(1);

        const { asIndex } = stubIndex({
            search: vi.fn<DocsIndex["search"]>(async () => {
                throw new Error("index offline");
            }),
        });

        await expect(call(asIndex, "lunora_search_docs", { query: "a" })).rejects.toThrow("index offline");
    });
});

describe("lunora_get_doc", () => {
    it("returns the page as markdown under a title header", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const result = await call(asIndex, "lunora_get_doc", { url: "https://lunora.sh/docs/sharding/" });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toBe("# Sharding (/docs/sharding)\n\nUse `.shardBy(key)` to partition state.");
    });

    it("points at the discovery tools when the page is unknown", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const result = await call(asIndex, "lunora_get_doc", { url: "/docs/nope" });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("lunora_search_docs");
    });
});

describe("lunora_list_docs", () => {
    it("lists every page", async () => {
        expect.assertions(1);

        const { asIndex } = stubIndex();
        const result = await call(asIndex, "lunora_list_docs", {});
        const parsed = JSON.parse(textOf(result)) as DocsPageSummary[];

        expect(parsed.map((page) => page.url)).toStrictEqual(["/docs/sharding", "/docs/schema"]);
    });
});
