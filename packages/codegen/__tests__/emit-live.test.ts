import { runInNewContext } from "node:vm";

import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";

import { encodeLiveTopic } from "../../../shared/live-stream";
import { emitLive } from "../src/emit";
import type { LiveStreamIR } from "../src/ir";

const posts: LiveStreamIR = {
    exportName: "posts",
    filePath: "live",
    id: "posts-stream",
    topics: [
        { fields: ["postId", "kind"], name: "post" },
        { fields: [], name: "feed" },
    ],
};

/** Evaluate the emitted module, which has no runtime import to inject, and return its `live` object. */
const evaluate = (source: string): Record<string, Record<string, (key?: Record<string, string>) => unknown>> => {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    // A top-level `var` in a vm context lands on the sandbox, which is how `live` comes back out.
    const body = outputText.replaceAll(/^import .*$/gmu, "").replace("export const live =", "var live =");
    const sandbox: { live?: unknown } = {};

    // eslint-disable-next-line sonarjs/code-eval -- evaluates the emitter's own output, in an empty context
    runInNewContext(body, sandbox);

    return sandbox.live as never;
};

describe("emitLive", () => {
    it("emits nothing when the project declares no live stream", () => {
        expect.assertions(1);

        expect(emitLive([])).toBe("");
    });

    it("imports the stream as a type only, so the module carries no server code", () => {
        expect.assertions(4);

        const source = emitLive([posts]);

        expect(source).toContain('import type { posts as postsStream } from "../live.js";');
        expect(source).not.toMatch(/^import (?!type)/mu);
        expect(source).not.toContain("defineLiveStream");
        // The only package it names is the server's, for types: a backend-only worker can import it to publish.
        expect([...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1])).toStrictEqual(["@lunora/server", "../live.js"]);
    });

    it("takes the specifiers from the umbrella when the project depends on it", () => {
        expect.assertions(2);

        const source = emitLive([posts], true);

        expect(source).toContain('from "lunorash/server"');
        expect(source).not.toContain('"@lunora/');
    });

    it("imports no key type when every topic is keyless", () => {
        expect.assertions(2);

        const source = emitLive([{ ...posts, topics: [{ fields: [], name: "feed" }] }]);

        expect(source).not.toContain("encodeURIComponent");
        expect(source).not.toContain("LiveTopicKey");
    });

    it("builds a ref whose topic is the server's encoding, in declared key order", () => {
        expect.assertions(4);

        const { posts: refs } = evaluate(emitLive([posts])) as { posts: { feed: () => unknown; post: (key: Record<string, string>) => unknown } };

        // The caller's object order must not matter: the segments follow the declaration.
        expect(refs.post({ kind: "news", postId: "p1" })).toEqual({ __lunoraLive: "posts-stream", topic: "post:p1:news" });
        expect(refs.post({ postId: "p1", kind: "news" })).toEqual({ __lunoraLive: "posts-stream", topic: "post:p1:news" });
        // A delimiter in a key is escaped, so it stays one segment.
        expect(refs.post({ kind: "a:b", postId: "p%1" })).toEqual({ __lunoraLive: "posts-stream", topic: "post:p%251:a%3Ab" });
        expect(refs.feed()).toEqual({ __lunoraLive: "posts-stream", topic: "feed" });
    });

    it("encodes every key exactly as the shared encoder the server parses with", () => {
        expect.assertions(1);

        const { posts: refs } = evaluate(emitLive([posts])) as { posts: { post: (key: Record<string, string>) => { topic: string } } };
        const values = ["", "plain", "a:b", "p%1", "%3A", "a b", "ü€", "x/y?z#w", "::"];
        const topics = values.flatMap((postId) =>
            values.map((kind) => {
                return { actual: refs.post({ kind, postId }).topic, expected: encodeLiveTopic("post", ["postId", "kind"], { kind, postId }) };
            }),
        );

        expect(topics.filter(({ actual, expected }) => actual !== expected)).toStrictEqual([]);
    });
});
