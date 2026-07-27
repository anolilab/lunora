import { describe, expect, it, vi } from "vitest";

import { createRemoteDocsIndex, parseIndexLine } from "../src/docs/remote-index";

/** A `fetch` double answering from a path → body map; anything else 404s. */
const stubFetch = (
    routes: Record<string, string>,
): {
    asFetch: typeof fetch;
    calls: string[];
} => {
    const calls: string[] = [];

    const asFetch = vi.fn<(input: string | URL) => Promise<Response>>(async (input) => {
        const url = typeof input === "string" ? input : input.href;

        calls.push(url);

        const path = url.slice("https://docs.test".length);
        const body = routes[path];

        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    return { asFetch, calls };
};

describe("parseIndexLine", () => {
    it("parses a titled link with a description", () => {
        expect.assertions(1);

        expect(parseIndexLine("- [Sharding](/docs/sharding): Partition state")).toStrictEqual({
            description: "Partition state",
            title: "Sharding",
            url: "/docs/sharding",
        });
    });

    it("parses a link without a description", () => {
        expect.assertions(1);

        expect(parseIndexLine("  - [Schema](/docs/schema)")).toStrictEqual({ title: "Schema", url: "/docs/schema" });
    });

    it("handles brackets inside the title", () => {
        expect.assertions(1);

        expect(parseIndexLine("- [Values [v.*]](/docs/values)")).toStrictEqual({ title: "Values [v.*]", url: "/docs/values" });
    });

    it.each(["## Guides", "", "Some prose about docs.", "- not a link", "- [broken](", "- []()"])("ignores %j", (line) => {
        expect.assertions(1);

        expect(parseIndexLine(line)).toBeUndefined();
    });
});

describe("createRemoteDocsIndex", () => {
    it("searches through the docs site search API", async () => {
        expect.assertions(2);

        const { asFetch, calls } = stubFetch({
            "/api/search?query=shard%20by": JSON.stringify([
                { content: "Sharding", type: "page", url: "/docs/sharding" },
                { breadcrumbs: ["Guides", "Sharding"], content: "Use <mark>shardBy</mark> to partition", type: "text", url: "/docs/sharding#occ" },
            ]),
        });

        const hits = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).search("shard by", 10);

        expect(calls[0]).toBe("https://docs.test/api/search?query=shard%20by");
        expect(hits).toStrictEqual([
            { title: "Sharding", url: "/docs/sharding" },
            { excerpt: "Use shardBy to partition", section: "Guides › Sharding", title: "Sharding", url: "/docs/sharding#occ" },
        ]);
    });

    it("stops at the requested limit", async () => {
        expect.assertions(1);

        const { asFetch } = stubFetch({
            "/api/search?query=a": JSON.stringify(
                Array.from({ length: 8 }, (_, index) => {
                    return { content: `p${String(index)}`, type: "page", url: `/docs/${String(index)}` };
                }),
            ),
        });

        const hits = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).search("a", 3);

        expect(hits).toHaveLength(3);
    });

    it("returns no hits when the site is unreachable or the body is not JSON", async () => {
        expect.assertions(3);

        const { asFetch } = stubFetch({ "/api/search?query=a": "<html>oops</html>" });
        const index = createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch });

        await expect(index.search("a", 5)).resolves.toStrictEqual([]);
        await expect(index.search("missing", 5)).resolves.toStrictEqual([]);

        const throwingFetch = vi.fn<() => Promise<Response>>(async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;

        await expect(createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: throwingFetch }).search("a", 5)).resolves.toStrictEqual([]);
    });

    it("reads a page through the llms.mdx route and strips its duplicate title line", async () => {
        expect.assertions(2);

        const { asFetch, calls } = stubFetch({
            "/llms.mdx/docs/sharding": "# Sharding (/docs/sharding)\n\nUse `.shardBy(key)`.",
        });

        const page = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).getPage("/docs/sharding");

        expect(calls[0]).toBe("https://docs.test/llms.mdx/docs/sharding");
        expect(page).toStrictEqual({ content: "Use `.shardBy(key)`.", title: "Sharding", url: "/docs/sharding" });
    });

    it("returns undefined for a page the site does not serve", async () => {
        expect.assertions(1);

        const { asFetch } = stubFetch({});

        await expect(createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).getPage("/docs/nope")).resolves.toBeUndefined();
    });

    it("lists pages from llms.txt", async () => {
        expect.assertions(1);

        const { asFetch } = stubFetch({
            "/llms.txt": "# Lunora\n\n## Docs\n\n- [Sharding](/docs/sharding): Partition state\n- [Schema](/docs/schema)\n",
        });

        const pages = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).listPages();

        expect(pages).toStrictEqual([
            { description: "Partition state", title: "Sharding", url: "/docs/sharding" },
            { title: "Schema", url: "/docs/schema" },
        ]);
    });

    it("normalizes a base URL with a trailing slash", async () => {
        expect.assertions(1);

        const { asFetch, calls } = stubFetch({ "/llms.txt": "" });

        await createRemoteDocsIndex({ baseUrl: "https://docs.test/", fetch: asFetch }).listPages();

        expect(calls[0]).toBe("https://docs.test/llms.txt");
    });
});
