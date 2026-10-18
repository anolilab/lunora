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

/** Evaluate the emitted module with the real encoder injected for its client import, returning its `live` object. */
const evaluate = (source: string): Record<string, Record<string, (key?: Record<string, string>) => unknown>> => {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    // A top-level `var` in a vm context lands on the sandbox, which is how `live` comes back out.
    const body = outputText.replaceAll(/^import .*$/gmu, "").replace("export const live =", "var live =");
    const sandbox: { encodeLiveTopic: typeof encodeLiveTopic; live?: unknown } = { encodeLiveTopic };

    // eslint-disable-next-line sonarjs/code-eval -- evaluates the emitter's own output, in a context holding only the encoder
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
        expect(source).not.toMatch(/^import (?!type)[^\n]*"\.\.\//mu);
        expect(source).not.toContain("defineLiveStream");
        expect(source).toContain('import { encodeLiveTopic } from "@lunora/client";');
    });

    it("takes the specifiers from the umbrella when the project depends on it", () => {
        expect.assertions(2);

        const source = emitLive([posts], true);

        expect(source).toContain('from "lunorash/client"');
        expect(source).toContain('from "lunorash/server"');
    });

    it("imports neither the encoder nor the key type when every topic is keyless", () => {
        expect.assertions(2);

        const source = emitLive([{ ...posts, topics: [{ fields: [], name: "feed" }] }]);

        expect(source).not.toContain("encodeLiveTopic");
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
});
