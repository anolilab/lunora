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

    it("unescapes the backslash escaping fumadocs writes into the index", () => {
        expect.assertions(1);

        expect(parseIndexLine(String.raw`- [Values \[v.*\]](/docs/values \(all\))`)).toStrictEqual({ title: "Values [v.*]", url: "/docs/values (all)" });
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

        const hits = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).search("shard by");

        expect(calls[0]).toBe("https://docs.test/api/search?query=shard%20by");
        expect(hits).toStrictEqual([
            { title: "Sharding", url: "/docs/sharding" },
            { excerpt: "Use shardBy to partition", section: "Guides › Sharding", title: "Sharding", url: "/docs/sharding#occ" },
        ]);
    });

    it("returns everything the backend found — the tool layer decides how much reaches the model", async () => {
        expect.assertions(1);

        const { asFetch } = stubFetch({
            "/api/search?query=a": JSON.stringify(
                Array.from({ length: 8 }, (_, index) => {
                    return { content: `p${String(index)}`, type: "page", url: `/docs/${String(index)}` };
                }),
            ),
        });

        const hits = await createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch }).search("a");

        expect(hits).toHaveLength(8);
    });

    it("returns no hits for a miss or an unparseable body", async () => {
        expect.assertions(2);

        const { asFetch } = stubFetch({ "/api/search?query=a": "<html>oops</html>" });
        const index = createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: asFetch });

        await expect(index.search("a")).resolves.toStrictEqual([]);
        await expect(index.search("missing")).resolves.toStrictEqual([]);
    });

    it("reports an unreachable host rather than reporting no results", async () => {
        expect.assertions(1);

        const throwingFetch = vi.fn<() => Promise<Response>>(async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;

        // A misconfigured --docs-url must be distinguishable from a genuine
        // miss, or the model can never tell its user what to fix.
        await expect(createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: throwingFetch }).search("a")).rejects.toThrow(/could not reach/);
    });

    it("gives up on an unresponsive host instead of hanging", async () => {
        expect.assertions(1);

        const hangingFetch = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
            async (_input, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => { reject(new Error("The operation was aborted")); });
                }),
        ) as unknown as typeof fetch;

        await expect(createRemoteDocsIndex({ baseUrl: "https://docs.test", fetch: hangingFetch, timeoutMs: 20 }).search("a")).rejects.toThrow(
            /could not reach/,
        );
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
