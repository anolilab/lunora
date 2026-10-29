import { wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import instrumentModel from "../src/telemetry";
import type { AiTelemetry } from "../src/types";

const stubModel = () => {
    return {
        doGenerate: vi.fn<(options?: unknown) => Promise<unknown>>(async () => {
            return {
                content: [{ text: "hi", type: "text" }],
                finishReason: "stop",
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
                warnings: [],
            };
        }),
        doStream: vi.fn<(options?: unknown) => Promise<unknown>>(async () => {
            return {
                stream: new ReadableStream({
                    start: (controller) => {
                        controller.close();
                    },
                }),
            };
        }),
        modelId: "stub/model",
        provider: "stub",
        specificationVersion: "v4" as const,
        supportedUrls: {},
    };
};

const telemetry = (): AiTelemetry => ({ metrics: { count: vi.fn<() => void>(), record: vi.fn<() => void>() } }) as unknown as AiTelemetry;

describe("instrumentModel lazy delegate", () => {
    it("passes the model through untouched without telemetry", () => {
        expect.assertions(1);

        const model = stubModel();

        expect(instrumentModel(model as never, undefined)).toBe(model);
    });

    it("matches wrapLanguageModel on identity fields and forwarded results", async () => {
        expect.assertions(8);

        const model = stubModel();
        const lazy = instrumentModel(model as never, telemetry(), "stub/model") as unknown as ReturnType<typeof stubModel>;
        const eager = wrapLanguageModel({ middleware: {}, model: stubModel() as never }) as unknown as ReturnType<typeof stubModel>;

        expect(lazy.specificationVersion).toBe(eager.specificationVersion);
        expect(lazy.modelId).toBe(eager.modelId);
        expect(lazy.provider).toBe(eager.provider);
        await expect(Promise.resolve(lazy.supportedUrls)).resolves.toStrictEqual(await Promise.resolve(eager.supportedUrls));

        const options = { prompt: [] } as never;

        await expect(lazy.doGenerate(options)).resolves.toMatchObject({ content: [{ text: "hi" }], finishReason: "stop" });
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        const streamed = (await lazy.doStream(options)) as { stream: ReadableStream };

        expect(streamed.stream).toBeInstanceOf(ReadableStream);
        expect(model.doStream).toHaveBeenCalledTimes(1);
    });

    it("reports v4 and matches wrapLanguageModel for a bring-your-own v3 model", async () => {
        expect.assertions(3);

        const v3 = () => {
            return {
                ...stubModel(),
                doGenerate: async () => {
                    return {
                        content: [{ text: "hi", type: "text" }],
                        finishReason: "stop",
                        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                        warnings: [],
                    };
                },
                specificationVersion: "v3" as const,
            };
        };
        const lazy = instrumentModel(v3() as never, telemetry(), "stub/model") as unknown as ReturnType<typeof stubModel>;
        const eager = wrapLanguageModel({ middleware: {}, model: v3() as never }) as unknown as ReturnType<typeof stubModel>;
        const options = { prompt: [] } as never;

        expect(lazy.specificationVersion).toBe("v4");
        expect(eager.specificationVersion).toBe("v4");
        await expect(lazy.doGenerate(options)).resolves.toStrictEqual(await eager.doGenerate(options));
    });
});
