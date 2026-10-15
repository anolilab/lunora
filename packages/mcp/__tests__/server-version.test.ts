import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createLunoraMcpServer } from "../src/server";
import connectStdio from "../src/stdio";

// Stand in for a build-time constant that lags the manifest by a release.
vi.mock(import("../package.json"), () => {
    return { default: { version: "0.0.0-bundled" } as never };
});

vi.mock(import("@modelcontextprotocol/sdk/server/stdio.js"), () => {
    return {
        StdioServerTransport: class {
            public readonly close = vi.fn<() => void>();

            public readonly send = vi.fn<() => void>();

            public readonly start = vi.fn<() => void>();
        } as never,
    };
});

// eslint-disable-next-line no-underscore-dangle -- the SDK keeps the handshake info private; there is no public accessor.
const advertised = (server: unknown): string => (server as { _serverInfo: { version: string } })._serverInfo.version;

describe("handshake version", () => {
    it("reports the installed manifest's current version on the Node (stdio) path", async () => {
        expect.assertions(1);

        const manifest = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };
        const server = await connectStdio({ client: {} as never });

        expect(advertised(server)).toBe(manifest.version);
    });

    it("reports the bundled constant on the worker path", () => {
        expect.assertions(1);
        expect(advertised(createLunoraMcpServer({ client: {} as never }))).toBe("0.0.0-bundled");
    });
});
