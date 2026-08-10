import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument } from "../src/sdk";
import { generateSdk, isTypedSchema } from "../src/sdk";
import { memberName, pythonTarget } from "../src/sdk/targets/python";

const fixture = (): OpenRpcDocument =>
    JSON.parse(readFileSync(join(__dirname, "fixtures", "simple", "expected", "_generated", "openrpc.json"), "utf8")) as OpenRpcDocument;

describe("python memberName", () => {
    it("splits camelCase and escapes Python keywords", () => {
        expect.assertions(3);

        expect(memberName("listMessages")).toBe("list_messages");
        expect(memberName("sendMessage")).toBe("send_message");
        // `import` is a Python keyword — an un-escaped `def import(...)` is a SyntaxError.
        expect(memberName("import")).toBe("import_");
    });
});

describe("isTypedSchema", () => {
    it("rejects the description-only result placeholder", () => {
        expect.assertions(3);

        // What `openrpc.ts` emits for a function with no declared `.output()`.
        expect(isTypedSchema({ description: "Result is TS-inferred …" })).toBe(false);
        expect(isTypedSchema({ properties: {}, type: "object" })).toBe(true);
        expect(isTypedSchema(undefined)).toBe(false);
    });
});

describe("generateSdk (python)", () => {
    it("emits a namespaced surface that dispatches on functionPath", async () => {
        expect.assertions(9);

        const document = fixture();
        const { files } = await generateSdk(document, pythonTarget);

        expect(Object.keys(files).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["__init__.py", "api.py", "models.py"]);

        const api = files["api.py"] ?? "";

        // One class per namespace, one method per function, snake_cased.
        expect(api).toContain("class MessagesApi:");
        expect(api).toContain("async def list(self, args: MessagesListArgs, *, shard_key: Optional[str] = None) -> Any:");
        expect(api).toContain("async def send(self, args: MessagesSendArgs, *, shard_key: Optional[str] = None) -> Any:");

        // The wire identifier is emitted verbatim, and the kind picks the runtime call.
        expect(api).toContain('await self._client.query("messages:list", args.to_dict(), shard_key)');
        expect(api).toContain('await self._client.mutation("messages:send", args.to_dict(), shard_key)');

        // Root entry point hangs each namespace off one object.
        expect(api).toContain("self.messages = MessagesApi(client)");

        // Models the surface references must exist in models.py, or the import
        // points at a class that was never rendered.
        expect(files["models.py"]).toContain("class MessagesListArgs:");
        expect(files["models.py"]).toContain("class MessagesSendArgs:");
    });

    it("renders the model layer from the args schemas", async () => {
        expect.assertions(5);

        const { files: generated } = await generateSdk(fixture(), pythonTarget);
        const models = generated["models.py"] ?? "";

        // quicktype maps the wire's camelCase onto snake_case fields and back.
        expect(models).toContain("channel_id: str");
        expect(models).toContain('result["channelId"] = from_str(self.channel_id)');
        // Optional (absent from `required`), enum (anyOf of consts), record.
        expect(models).toContain("limit: Optional[float] = None");
        expect(models).toContain("class Kind(Enum):");
        expect(models).toContain("tags: Dict[str, str]");
    });

    it("is deterministic — a second run is byte-identical", async () => {
        expect.assertions(1);

        const document = fixture();
        const { files: first } = await generateSdk(document, pythonTarget);
        const { files: second } = await generateSdk(document, pythonTarget);

        expect(second).toStrictEqual(first);
    });

    it("emits a subscribe_* only for queries, never for writes", async () => {
        expect.assertions(4);

        const document = fixture();
        const { files } = await generateSdk(document, pythonTarget);
        const api = files["api.py"] ?? "";

        // `messages:list` is a query — it gets a live subscription.
        expect(api).toContain("def subscribe_list(");
        expect(api).toContain('return self._client.subscribe("messages:list", args.to_dict(), on_data, on_error, shard_key)');
        // `messages:send` is a mutation — the server has nothing to re-run.
        expect(api).not.toContain("def subscribe_send(");
        // The callback aliases are imported only because a subscription exists.
        expect(api).toContain("from lunora.client import Callback, ErrorCallback, LunoraClient, Unsubscribe");
    });

    it("dispatches each kind to its own runtime call", async () => {
        expect.assertions(3);

        const document: OpenRpcDocument = {
            methods: [
                { name: "billing:charge", "x-lunora-function-kind": "action" },
                { name: "billing:record", "x-lunora-function-kind": "mutation" },
                { name: "billing:total", "x-lunora-function-kind": "query" },
            ],
        };
        const { files } = await generateSdk(document, pythonTarget);
        const api = files["api.py"] ?? "";

        // `action` must NOT fold into `mutation`: only `mutation` carries an
        // idempotency key, which the server does not honour for actions.
        expect(api).toContain('await self._client.action("billing:charge", {}, shard_key)');
        expect(api).toContain('await self._client.mutation("billing:record", {}, shard_key)');
        expect(api).toContain('await self._client.query("billing:total", {}, shard_key)');
    });

    it("types the result when the method declares an output schema", async () => {
        expect.assertions(3);

        const document: OpenRpcDocument = {
            methods: [
                {
                    name: "messages:count",
                    result: { name: "result", schema: { properties: { total: { type: "number" } }, type: "object" } },
                    "x-lunora-function-kind": "query",
                },
            ],
        };
        const { files } = await generateSdk(document, pythonTarget);
        const api = files["api.py"] ?? "";

        expect(api).toContain("-> MessagesCountResult:");
        expect(api).toContain('return MessagesCountResult.from_dict(await self._client.query("messages:count", {}, shard_key))');
        expect(files["models.py"]).toContain("class MessagesCountResult:");
    });

    it("falls back to `Any` while results carry no schema", async () => {
        expect.assertions(2);

        const document = fixture();
        const { files } = await generateSdk(document, pythonTarget);
        const api = files["api.py"] ?? "";

        // Both fixture functions lack `.output()`, so nothing is typed on return.
        expect(api).not.toContain("Result.from_dict");
        expect(api.match(/-> Any:/gu)).toHaveLength(2);
    });

    it("narrows the bare `except:` quicktype writes into its from_union helper", async () => {
        expect.assertions(2);

        // A bare handler catches BaseException, so a KeyboardInterrupt raised
        // while a union member is being decoded is swallowed and the loop just
        // tries the next member. Every union-typed field routes through that
        // helper, so the fix belongs in the emitter rather than in each consumer.
        const { files } = await generateSdk(fixture(), pythonTarget);
        const models = files["models.py"] ?? "";

        expect(models).toContain("except Exception:");
        expect(models).not.toMatch(/^[ \t]*except:[ \t]*$/mu);
    });
});
