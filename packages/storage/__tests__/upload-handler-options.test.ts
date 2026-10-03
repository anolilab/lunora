/**
 * The options `createUploadHandler` builds the `@visulima/storage` protocol
 * handlers with, pinned on their own: the route's header checks would hide a
 * missing option from every behavioural test.
 */
import { MemoryStorage } from "@visulima/storage/provider/memory";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUploadHandler } from "../src/upload-handler";

const built = vi.hoisted(() => [] as { options: Record<string, unknown>; protocol: string }[]);

vi.mock(import("@visulima/storage/handler/http/fetch"), async (importOriginal) => {
    const actual = await importOriginal();

    /** The real handler class, recording the options each instance is built with. */
    const recording = <T extends object>(target: T, protocol: string): T =>
        new Proxy(target, {
            construct(constructor, args: unknown[], newTarget: object) {
                built.push({ options: args[0] as Record<string, unknown>, protocol });

                return Reflect.construct(constructor as unknown as new (...parameters: unknown[]) => object, args, newTarget as new () => object);
            },
        });

    return {
        ...actual,
        Multipart: recording(actual.Multipart, "multipart"),
        Rest: recording(actual.Rest, "chunked-rest"),
        Tus: recording(actual.Tus, "tus"),
    };
});

describe("createUploadHandler's protocol handler options", () => {
    beforeEach(() => {
        built.length = 0;
    });

    it.each(["tus", "chunked-rest", "multipart"] as const)("builds the %s handler with method overrides off and a 16 MiB checksum buffer", (protocol) => {
        expect.hasAssertions();

        createUploadHandler({ protocol, silent: true, storage: new MemoryStorage({ path: "/upload" }) });

        expect(built).toHaveLength(1);
        expect(built[0]?.protocol).toBe(protocol);
        expect(built[0]?.options).toMatchObject({
            allowMethodOverride: false,
            disableTerminationForFinishedUploads: true,
            maxChecksumBufferSize: 16 * 1024 * 1024,
        });
    });

    it("lowers the checksum buffer to maxFileSize when that is smaller", () => {
        expect.hasAssertions();

        createUploadHandler({ maxFileSize: 1024, silent: true, storage: new MemoryStorage({ path: "/upload" }) });

        expect(built[0]?.options).toMatchObject({ maxChecksumBufferSize: 1024, maxFileSize: 1024 });
    });
});
