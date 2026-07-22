import { describe, expect, it } from "vitest";

import { createHttpCloudflareApi } from "../src/cloudflare/api";

/** Capture the WfP multipart `metadata` part of a `putDispatchScript` upload. */
const captureMetadata = async (input: Parameters<ReturnType<typeof createHttpCloudflareApi>["putDispatchScript"]>[0]): Promise<Record<string, unknown>> => {
    let captured: Record<string, unknown> = {};

    const api = createHttpCloudflareApi({
        accountId: "acct",
        apiToken: "token",
        fetch: (async (_url: string, init: { body: FormData }) => {
            const metadata = (init.body as FormData).get("metadata") as Blob;
            captured = JSON.parse(await metadata.text()) as Record<string, unknown>;

            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof globalThis.fetch,
    });

    await api.putDispatchScript(input);

    return captured;
};

const baseInput = {
    bindings: [{ class_name: "ShardDO", name: "SHARD", type: "durable_object_namespace" as const }],
    bundle: new ArrayBuffer(8),
    mainModule: "index.js",
    namespace: "lunora-production",
    newSqliteClasses: ["ShardDO"],
    scriptName: "app-v1",
    tags: ["org:o1"],
};

describe("putDispatchScript telemetry metadata", () => {
    it("emits tail_consumers and plain_text var bindings when provided", async () => {
        const metadata = await captureMetadata({
            ...baseInput,
            tailConsumers: ["lunora-log-tail"],
            vars: { LUNORA_OTLP_ENDPOINT: "https://cloud.lunora.app" },
        });

        expect(metadata.tail_consumers).toStrictEqual([{ service: "lunora-log-tail" }]);
        expect(metadata.bindings).toContainEqual({ name: "LUNORA_OTLP_ENDPOINT", text: "https://cloud.lunora.app", type: "plain_text" });
        // The DO binding is preserved alongside the injected var binding.
        expect(metadata.bindings).toContainEqual({ class_name: "ShardDO", name: "SHARD", type: "durable_object_namespace" });
    });

    it("omits tail_consumers entirely when none are given", async () => {
        const metadata = await captureMetadata(baseInput);

        expect(metadata).not.toHaveProperty("tail_consumers");
        expect(metadata.bindings).toStrictEqual(baseInput.bindings);
    });
});
