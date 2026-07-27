import { describe, expect, it, vi } from "vitest";

import { callDocsTool, DOCS_TOOL_DEFINITIONS, docsTools, MAX_SEARCH_LIMIT, normalizeDocUrl } from "../src/docs/tools";
import type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "../src/docs/types";

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
    const search = vi.fn<(query: string, limit: number) => Promise<ReadonlyArray<DocsSearchHit>>>(async () => [
        { excerpt: "Use .shardBy(key)", section: "Guides › Sharding", title: "Sharding", url: "/docs/sharding" },
    ]);

    return { asIndex: { getPage, listPages, search, ...overrides }, getPage, listPages, search };
};

const textOf = (result: { content: { text: string }[] }): string => result.content.map((part) => part.text).join("");

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
        ["/docs/sharding/", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding#occ", "/docs/sharding"],
        ["https://lunora.sh/docs/sharding?x=1", "/docs/sharding"],
        ["  /docs/sharding  ", "/docs/sharding"],
    ])("normalizes %s", (input, expected) => {
        expect.assertions(1);

        expect(normalizeDocUrl(input)).toBe(expected);
    });
});

describe("lunora_search_docs", () => {
    it("returns hits for a query", async () => {
        expect.assertions(3);

        const { asIndex, search } = stubIndex();
        const result = await callDocsTool(asIndex, "lunora_search_docs", { query: "sharding" });

        expect(result.isError).toBeUndefined();
        expect(search).toHaveBeenCalledWith("sharding", 10);
        expect(textOf(result)).toContain("/docs/sharding");
    });

    it("clamps the limit into range and accepts a numeric string", async () => {
        expect.assertions(4);

        const { asIndex, search } = stubIndex();

        await callDocsTool(asIndex, "lunora_search_docs", { limit: 999, query: "a" });

        expect(search).toHaveBeenLastCalledWith("a", MAX_SEARCH_LIMIT);

        await callDocsTool(asIndex, "lunora_search_docs", { limit: 0, query: "a" });

        expect(search).toHaveBeenLastCalledWith("a", 1);

        await callDocsTool(asIndex, "lunora_search_docs", { limit: "3", query: "a" });

        expect(search).toHaveBeenLastCalledWith("a", 3);

        await callDocsTool(asIndex, "lunora_search_docs", { limit: "nonsense", query: "a" });

        expect(search).toHaveBeenLastCalledWith("a", 10);
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

        const result = await callDocsTool(asIndex, "lunora_search_docs", { limit: 2, query: "a" });
        const parsed = JSON.parse(textOf(result)) as { hits: unknown[] };

        expect(parsed.hits).toHaveLength(2);
    });

    it("suggests a next step when nothing matches", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex({ search: vi.fn<DocsIndex["search"]>(async () => []) });
        const result = await callDocsTool(asIndex, "lunora_search_docs", { query: "zzz" });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toContain("lunora_list_docs");
    });

    it("rejects a missing or blank query", async () => {
        expect.assertions(9);

        const { asIndex, search } = stubIndex();

        const results = await Promise.all(
            [{}, { query: "" }, { query: "   " }, { query: 42 }].map(async (input) => callDocsTool(asIndex, "lunora_search_docs", input)),
        );

        for (const result of results) {
            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain("query");
        }

        expect(search).not.toHaveBeenCalled();
    });

    it("surfaces a backend failure as a tool error, not a rejection", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex({
            search: vi.fn<DocsIndex["search"]>(async () => {
                throw new Error("index offline");
            }),
        });

        const result = await callDocsTool(asIndex, "lunora_search_docs", { query: "a" });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("index offline");
    });
});

describe("lunora_get_doc", () => {
    it("returns the page as markdown under a title header", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const result = await callDocsTool(asIndex, "lunora_get_doc", { url: "https://lunora.sh/docs/sharding/" });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toBe("# Sharding (/docs/sharding)\n\nUse `.shardBy(key)` to partition state.");
    });

    it("points at the discovery tools when the page is unknown", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const result = await callDocsTool(asIndex, "lunora_get_doc", { url: "/docs/nope" });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("lunora_search_docs");
    });
});

describe("lunora_list_docs", () => {
    it("lists every page", async () => {
        expect.assertions(1);

        const { asIndex } = stubIndex();
        const result = await callDocsTool(asIndex, "lunora_list_docs", {});
        const parsed = JSON.parse(textOf(result)) as DocsPageSummary[];

        expect(parsed.map((page) => page.url)).toStrictEqual(["/docs/sharding", "/docs/schema"]);
    });
});

describe("unknown tools", () => {
    it("reports the name rather than throwing", async () => {
        expect.assertions(2);

        const { asIndex } = stubIndex();
        const result = await callDocsTool(asIndex, "lunora_delete_everything", {});

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("unknown tool: lunora_delete_everything");
    });
});
