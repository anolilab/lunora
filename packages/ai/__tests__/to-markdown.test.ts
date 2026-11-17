import { isLunoraError } from "@lunora/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import createAi from "../src/create-ai";
import type { AiBindingLike, AiMarkdownConversionResult, AiMarkdownDocument } from "../src/types";

interface MarkdownCall {
    document: AiMarkdownDocument;
    options: Record<string, unknown> | undefined;
}

/**
 * A fake `env.AI` whose `toMarkdown` records every call and returns a canned
 * result, so the normalisation can be asserted without the real binding.
 */
const markdownBinding = (result?: AiMarkdownConversionResult | AiMarkdownConversionResult[]): AiBindingLike & { markdownCalls: MarkdownCall[] } => {
    const markdownCalls: MarkdownCall[] = [];
    const conversion = result ?? { data: "# Hi", format: "markdown", mimetype: "application/pdf", tokens: 3 };

    return {
        markdownCalls,
        run: async () => undefined,
        toMarkdown: async (files, options) => {
            markdownCalls.push({ document: files as AiMarkdownDocument, options });

            return conversion;
        },
    };
};

describe("ai.toMarkdown", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("converts a Blob and normalises the binding result", async () => {
        expect.assertions(2);

        const binding = markdownBinding();
        const result = await createAi({ binding }).toMarkdown(new Blob(["hello"], { type: "text/html" }), { name: "index.html" });

        expect(result).toStrictEqual({ markdown: "# Hi", mimeType: "application/pdf", tokens: 3 });
        expect(binding.markdownCalls).toStrictEqual([{ document: { blob: expect.any(Blob), name: "index.html" }, options: undefined }]);
    });

    it("unwraps a single-element array result, as the binding returns for one document", async () => {
        expect.assertions(1);

        const binding = markdownBinding([{ data: "body", format: "markdown", tokens: 1 }]);

        await expect(createAi({ binding }).toMarkdown(new Blob(["x"]))).resolves.toStrictEqual({ markdown: "body", tokens: 1 });
    });

    it("accepts raw bytes with an explicit mime type and name", async () => {
        expect.assertions(1);

        const binding = markdownBinding();

        await createAi({ binding }).toMarkdown(new Uint8Array([1, 2, 3]), { mimeType: "image/png", name: "cat.png" });

        expect(binding.markdownCalls[0]?.document.name).toBe("cat.png");
    });

    it("fetches a URL input and derives the document name from its path", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<() => Promise<Response>>(
            async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const binding = markdownBinding();
        const result = await createAi({ binding }).toMarkdown(new URL("https://example.com/docs/report.pdf"));

        expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), { redirect: "manual" });
        expect(result.markdown).toBe("# Hi");
        expect(binding.markdownCalls[0]?.document.name).toBe("report.pdf");
    });

    it("rejects a URL that cannot be fetched with BAD_REQUEST", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
        const error: unknown = await createAi({ binding: markdownBinding() })
            .toMarkdown(new URL("https://example.com/missing.pdf"))
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
    });

    it("refuses a document over the byte cap before it reaches the binding", async () => {
        expect.assertions(2);

        const binding = markdownBinding();
        const error: unknown = await createAi({ binding })
            .toMarkdown(new Blob(["1234"]), { maxBytes: 2, name: "big.pdf" })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "PAYLOAD_TOO_LARGE").toBe(true);
        expect(binding.markdownCalls).toStrictEqual([]);
    });

    it("refuses a URL whose declared Content-Length is over the cap without reading the body", async () => {
        expect.assertions(2);

        // The body errors if read: a declared-size refusal must fire before any byte is buffered.
        const body = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error("body was read");
            },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { headers: { "content-length": "100" } })),
        );
        const binding = markdownBinding();
        const error: unknown = await createAi({ binding })
            .toMarkdown(new URL("https://example.test/big.pdf"), { maxBytes: 2 })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "PAYLOAD_TOO_LARGE").toBe(true);
        expect(binding.markdownCalls).toStrictEqual([]);
    });

    it("refuses a URL without a Content-Length once its streamed bytes pass the cap", async () => {
        expect.assertions(2);

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5, 6]));
                controller.close();
            },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body)),
        );
        const binding = markdownBinding();
        const error: unknown = await createAi({ binding })
            .toMarkdown(new URL("https://example.test/chunked.pdf"), { maxBytes: 4 })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "PAYLOAD_TOO_LARGE").toBe(true);
        expect(binding.markdownCalls).toStrictEqual([]);
    });

    it("refuses an untyped input rather than converting it to an empty document", async () => {
        expect.assertions(2);

        const binding = markdownBinding();
        const error: unknown = await createAi({ binding })
            .toMarkdown("not bytes" as unknown as Uint8Array)
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect(binding.markdownCalls).toHaveLength(0);
    });

    it("refuses a non-numeric or non-positive maxBytes, which would admit any document", async () => {
        expect.assertions(2);

        const binding = markdownBinding();
        const nan: unknown = await createAi({ binding })
            .toMarkdown(new Blob(["x"]), { maxBytes: Number.NaN })
            .catch((error_: unknown) => error_);
        const zero: unknown = await createAi({ binding })
            .toMarkdown(new Blob(["x"]), { maxBytes: 0 })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(nan) && nan.code === "BAD_REQUEST").toBe(true);
        expect(isLunoraError(zero) && zero.code === "BAD_REQUEST").toBe(true);
    });

    it("refuses a URL that names this machine or a private network, without fetching it", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<() => Promise<Response>>(async () => new Response("secret"));
        vi.stubGlobal("fetch", fetchMock);
        const binding = markdownBinding();
        const error: unknown = await createAi({ binding })
            .toMarkdown(new URL("https://169.254.169.254/latest/meta-data"))
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not follow a redirect, and says so when one comes back", async () => {
        expect.assertions(2);

        vi.stubGlobal("fetch", async () => new Response(null, { headers: { location: "https://example.test/final.pdf" }, status: 302 }));
        const error: unknown = await createAi({ binding: markdownBinding() })
            .toMarkdown(new URL("https://example.test/short.pdf"))
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect((error as Error).message).toMatch(/pass the final URL/);
    });

    it("forwards conversion options to the binding", async () => {
        expect.assertions(1);

        const binding = markdownBinding();

        await createAi({ binding }).toMarkdown(new Blob(["x"]), { conversionOptions: { output: { format: "text" } } });

        expect(binding.markdownCalls[0]?.options).toStrictEqual({ output: { format: "text" } });
    });

    it("throws BAD_REQUEST when the binding reports an error result", async () => {
        expect.assertions(2);

        const binding = markdownBinding({ error: "unsupported format", format: "error", name: "broken.bin" });
        const error: unknown = await createAi({ binding })
            .toMarkdown(new Blob(["x"]))
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect((error as Error).message).toMatch(/unsupported format/);
    });

    it("throws a directed error without a binding, or with one that predates toMarkdown()", async () => {
        expect.assertions(2);

        await expect(createAi({}).toMarkdown(new Blob(["x"]))).rejects.toThrow(/ai\.toMarkdown needs the `AI` binding/);

        const error: unknown = await createAi({ binding: { run: async () => undefined } })
            .toMarkdown(new Blob(["x"]))
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "NOT_IMPLEMENTED").toBe(true);
    });
});
