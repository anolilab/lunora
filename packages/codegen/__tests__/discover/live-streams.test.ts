import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverLiveStreams from "../../src/discover/live-streams";

let workdir: string;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const discover = () => discoverLiveStreams(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), join(workdir, "lunora"));

const stream = (options: string): string => `import { defineLiveStream, v } from "@lunora/server";\n\nexport const posts = defineLiveStream(${options});\n`;

describe("discoverLiveStreams", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-live-streams-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the literal id, topic names and key fields in declared order", () => {
        expect.assertions(1);

        write(
            "live.ts",
            stream(`{
                id: "posts",
                topics: {
                    post: { key: { postId: v.string(), "kind": v.string() }, payload: v.null() },
                    feed: { payload: v.null() },
                },
            }`),
        );

        expect(discover()).toStrictEqual([
            {
                exportName: "posts",
                filePath: "live",
                id: "posts",
                topics: [
                    { fields: ["postId", "kind"], name: "post" },
                    { fields: [], name: "feed" },
                ],
            },
        ]);
    });

    it("finds nothing when no live stream is declared", () => {
        expect.assertions(1);

        write("plain.ts", `export const answer = 42;\n`);

        expect(discover()).toStrictEqual([]);
    });

    it.each(["as LiveStream", "satisfies LiveStream", "!"])("reads a named export whose call is wrapped with `%s`", (wrapper) => {
        expect.assertions(1);

        write(
            "live.ts",
            `import { defineLiveStream, v } from "@lunora/server";\nimport type { LiveStream } from "@lunora/server";\n\nexport const posts = (defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } }) ${wrapper});\n`.replace(
                ") !)",
                ")!)",
            ),
        );

        expect(discover().map((found) => found.exportName)).toStrictEqual(["posts"]);
    });

    it("reads a stream whose onSubscribe is method shorthand", () => {
        expect.assertions(1);

        write(
            "live.ts",
            `import { defineLiveStream, v } from "@lunora/server";\n\nexport const posts = defineLiveStream({\n    id: "posts",\n    topics: { a: { payload: v.null() } },\n    async onSubscribe() {\n        return true;\n    },\n});\n`,
        );

        expect(discover().map((found) => found.id)).toStrictEqual(["posts"]);
    });

    it("reads quoted spellings of id, topics and key the same as bare ones", () => {
        expect.assertions(1);

        write("live.ts", stream(`{ "id": "posts", "topics": { post: { "key": { postId: v.string() }, payload: v.null() }, "feed": { payload: v.null() } } }`));

        expect(discover()).toStrictEqual([
            {
                exportName: "posts",
                filePath: "live",
                id: "posts",
                topics: [
                    { fields: ["postId"], name: "post" },
                    { fields: [], name: "feed" },
                ],
            },
        ]);
    });

    it.each([
        [
            "a default export",
            `import { defineLiveStream, v } from "@lunora/server";\n\nexport default defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } });\n`,
        ],
        [
            "a local only",
            `import { defineLiveStream, v } from "@lunora/server";\n\nconst posts = defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } });\n\nvoid posts;\n`,
        ],
        [
            "a variable exported only as default",
            `import { defineLiveStream, v } from "@lunora/server";\n\nconst posts = defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } });\n\nexport default posts;\n`,
        ],
        [
            "an inline call",
            `import { defineLiveStream, v } from "@lunora/server";\n\nexport const routes = [defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } })];\n`,
        ],
    ])("refuses a stream that is %s, rather than leaving it unpublishable", (_label, source) => {
        expect.assertions(1);

        write("live.ts", source);

        expect(discover).toThrow(expect.objectContaining({ code: "LIVE_STREAM_NOT_EXPORTED" }));
    });

    it.each([
        ["a variable id", `{ id: someId, topics: { a: { payload: v.null() } } }`],
        ["a template id", "{ id: `posts`, topics: { a: { payload: v.null() } } }"],
        ["a missing id", `{ topics: { a: { payload: v.null() } } }`],
        ["a spread options object", `{ ...base, id: "posts", topics: {} }`],
        ["a non-literal topics map", `{ id: "posts", topics }`],
        ["a spread topics map", `{ id: "posts", topics: { ...shared, a: { payload: v.null() } } }`],
        ["a computed topic name", `{ id: "posts", topics: { [name]: { payload: v.null() } } }`],
        ["a topic that is a reference", `{ id: "posts", topics: { a: aTopic } }`],
        ["a method as a topic", `{ id: "posts", topics: { a() {} } }`],
        ["a spread topic declaration", `{ id: "posts", topics: { a: { ...base, payload: v.null() } } }`],
        ["a key that is a reference", `{ id: "posts", topics: { a: { key: keyFields, payload: v.null() } } }`],
        ["a spread key map", `{ id: "posts", topics: { a: { key: { ...keyFields, b: v.string() }, payload: v.null() } } }`],
        ["a computed key field", `{ id: "posts", topics: { a: { key: { [field]: v.string() }, payload: v.null() } } }`],
    ])("throws LIVE_STREAM_NOT_LITERAL for %s", (_label, options) => {
        expect.assertions(1);

        write("live.ts", stream(options));

        expect(discover).toThrow(expect.objectContaining({ code: "LIVE_STREAM_NOT_LITERAL" }));
    });

    it.each([
        ["a topic name with a delimiter", `{ id: "posts", topics: { "a:b": { payload: v.null() } } }`],
        ["a topic name in the room prefix", `{ id: "posts", topics: { room: { payload: v.null() } } }`],
        ["a key field with an escape character", `{ id: "posts", topics: { a: { key: { "b%": v.string() }, payload: v.null() } } }`],
    ])("rejects %s with LIVE_TOPIC_INVALID", (_label, options) => {
        expect.assertions(1);

        write("live.ts", stream(options));

        expect(discover).toThrow(expect.objectContaining({ code: "LIVE_TOPIC_INVALID" }));
    });

    it("rejects two streams that share an id or an export name", () => {
        expect.assertions(2);

        write("a.ts", stream(`{ id: "posts", topics: { a: { payload: v.null() } } }`));
        write("b.ts", stream(`{ id: "other", topics: { a: { payload: v.null() } } }`));

        expect(discover).toThrow(expect.objectContaining({ code: "LIVE_STREAM_DUPLICATE" }));

        write(
            "b.ts",
            `import { defineLiveStream, v } from "@lunora/server";\n\nexport const second = defineLiveStream({ id: "posts", topics: { a: { payload: v.null() } } });\n`,
        );

        expect(discover).toThrow(expect.objectContaining({ code: "LIVE_STREAM_DUPLICATE" }));
    });
});
