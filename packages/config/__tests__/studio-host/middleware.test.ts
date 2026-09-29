import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudioMiddleware, isNonLoopbackHost, STUDIO_PATH, studioMountPath } from "../../src/studio-host/middleware";

/* eslint-disable sonarjs/no-hardcoded-ip -- loopback/LAN fixtures for the bind and transport checks; no real connection is made */

const roots: string[] = [];

const projectRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lunora-studio-mw-"));

    roots.push(root);

    return root;
};

const request = (url: string, remoteAddress = "127.0.0.1"): IncomingMessage =>
    ({ headers: { host: "localhost:3000" }, method: "GET", socket: { remoteAddress }, url }) as unknown as IncomingMessage;

interface CapturedResponse {
    body: () => string;
    response: ServerResponse;
    status: () => number;
}

const capture = (): CapturedResponse => {
    let body = "";
    const response = {
        end: (chunk?: Buffer | string) => {
            body = chunk === undefined ? "" : String(chunk);
        },
        setHeader: () => response,
        statusCode: 0,
    };

    return { body: () => body, response: response as unknown as ServerResponse, status: () => response.statusCode };
};

describe(createStudioMiddleware, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("passes everything outside the mount through to the host", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const { response } = capture();

        middleware(request("/"), response, next);
        middleware(request("/__lunoraish"), response, next);

        // `/__lunoraish` shares the prefix but is not under the mount.
        expect(next).toHaveBeenCalledTimes(2);
        expect(STUDIO_PATH).toBe("/__lunora");
    });

    it("answers a deep link under the mount with the studio document", () => {
        expect.assertions(3);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const captured = capture();

        middleware(request("/__lunora/data?table=messages"), captured.response, next);

        expect(next).not.toHaveBeenCalled();
        expect(captured.status()).toBe(200);
        expect(captured.body()).toContain("/__lunora/studio.js");
    });

    it("matches the mount under a non-root base, as the dev server announces it", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ base: "/app/", isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const captured = capture();

        middleware(request("/app/__lunora"), captured.response, next);

        expect(next).not.toHaveBeenCalled();
        expect(captured.status()).toBe(200);
    });

    it("refuses on a non-loopback bind even for a loopback browser", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: true, projectRoot: projectRoot() });
        const captured = capture();

        middleware(request("/__lunora"), captured.response, vi.fn<() => void>());

        // The document embeds the admin token.
        expect(captured.status()).toBe(403);
        expect(captured.body()).not.toContain("studio.js");
    });

    it("refuses a non-loopback peer whatever the bind says", () => {
        expect.assertions(1);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        // Rsbuild binds `0.0.0.0` by default, so a LAN peer can reach the socket.
        middleware(request("/__lunora", "192.168.1.20"), captured.response, vi.fn<() => void>());

        expect(captured.status()).toBe(403);
    });
});

describe(isNonLoopbackHost, () => {
    it("treats an unset host as the bundler's default, not an intent to expose", () => {
        expect.assertions(4);

        expect(isNonLoopbackHost(undefined)).toBe(false);
        expect(isNonLoopbackHost(false)).toBe(false);
        expect(isNonLoopbackHost("localhost")).toBe(false);
        expect(isNonLoopbackHost("127.0.0.1")).toBe(false);
    });

    it("flags `--host` and explicit non-loopback addresses", () => {
        expect.assertions(3);

        expect(isNonLoopbackHost(true)).toBe(true);
        expect(isNonLoopbackHost("0.0.0.0")).toBe(true);
        expect(isNonLoopbackHost("192.168.1.20")).toBe(true);
    });
});

describe(studioMountPath, () => {
    it("moves the mount with the base", () => {
        expect.assertions(4);

        expect(studioMountPath()).toBe("/__lunora");
        expect(studioMountPath("/")).toBe("/__lunora");
        expect(studioMountPath("/app/")).toBe("/app/__lunora");
        expect(studioMountPath("/app")).toBe("/app/__lunora");
    });
});
