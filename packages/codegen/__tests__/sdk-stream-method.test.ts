import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument, OpenRpcMethod } from "../src/sdk";
import { generateSdk } from "../src/sdk";
import { pythonTarget } from "../src/sdk/targets/python";

/**
 * A `stream` is listed in the OpenRPC document for tooling, but it runs over the WebSocket.
 * An SDK that read it as a method would send it to the mutation verb, so no generator may
 * emit it.
 */
const withStream = (): OpenRpcDocument => {
    const document = JSON.parse(readFileSync(join(__dirname, "fixtures", "simple", "expected", "_generated", "openrpc.json"), "utf8")) as OpenRpcDocument;
    const query = document.methods.find((method) => method["x-lunora-function-kind"] === "query") as OpenRpcMethod;
    const feed: OpenRpcMethod = { ...query, name: "messages:feed", "x-lunora-function-kind": "stream" };

    return { ...document, methods: [...document.methods, feed] };
};

describe("generateSdk with a stream method in the document", () => {
    it("omits the stream from every generated file", async () => {
        expect.assertions(3);

        const { files } = await generateSdk(withStream(), pythonTarget);
        const everything = Object.values(files).join("\n");

        expect(everything).not.toContain("messages:feed");
        expect(everything).not.toContain("MessagesFeed");
        expect(everything).toContain('await self._client.query("messages:list"');
    });
});
