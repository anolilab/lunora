import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { emitFunctions, emitLazyFunctionModules, emitShard } from "../src/emit";
import type { FunctionIR } from "../src/ir";

interface FakeSocket {
    attachment: unknown;
    close: () => void;
    deserializeAttachment: () => unknown;
    frames: { chunk?: unknown; data?: unknown; id?: string; type?: string }[];
    send: (data: string) => void;
    serializeAttachment: (attachment: unknown) => void;
    waitForFrame: (id: string, type: string) => Promise<{ chunk?: unknown; data?: unknown; id?: string; type?: string }>;
}

interface GeneratedShard {
    fetch: (request: Request) => Promise<Response>;
    webSocketMessage: (socket: WebSocket, message: string) => Promise<void>;
}

type GeneratedShardClass = new (state: unknown, env: unknown) => GeneratedShard;

let projectRoot: string | undefined;
let stateKey: string | undefined;

const makeFunction = (filePath: string, exportName: string, overrides: Partial<FunctionIR> = {}): FunctionIR => {
    return {
        args: {},
        exportName,
        filePath,
        kind: "query",
        returnType: "string",
        ...overrides,
    };
};

const writeGeneratedShard = (functions: ReadonlyArray<FunctionIR>): { entry: string; output: string; root: string } => {
    projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-base-ingress-"));
    const generatedDirectory = join(projectRoot, "lunora", "_generated");
    const functionsOptions = { functions, lazyFunctions: true };

    mkdirSync(join(generatedDirectory, "fn"), { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(projectRoot, "lunora", "schema.ts"), "export default { tables: [], vectorIndexes: [] };\n");
    writeFileSync(join(generatedDirectory, "functions.ts"), emitFunctions(functionsOptions));
    writeFileSync(join(generatedDirectory, "shard.ts"), emitShard({ lazyFunctions: true, schema: { tables: [], vectorIndexes: [] } }));

    for (const [relativePath, source] of Object.entries(emitLazyFunctionModules(functionsOptions))) {
        writeFileSync(join(generatedDirectory, relativePath), source);
    }

    return { entry: join(generatedDirectory, "shard.ts"), output: join(projectRoot, "shard.mjs"), root: projectRoot };
};

const fakeSocket = (): FakeSocket => {
    const frames: { chunk?: unknown; data?: unknown; id?: string; type?: string }[] = [];
    const waiters = new Map<string, ((frame: { chunk?: unknown; data?: unknown; id?: string; type?: string }) => void)[]>();
    const key = (id: string, type: string): string => `${id}:${type}`;

    return {
        attachment: { subs: {} },
        close: () => undefined,
        deserializeAttachment() {
            return this.attachment;
        },
        frames,
        send(data) {
            const frame = JSON.parse(data) as { chunk?: unknown; data?: unknown; id?: string; type?: string };
            frames.push(frame);

            for (const resolve of waiters.get(key(frame.id ?? "", frame.type ?? "")) ?? []) {
                resolve(frame);
            }
        },
        serializeAttachment(attachment) {
            this.attachment = attachment;
        },
        waitForFrame(id, type) {
            const found = frames.find((frame) => frame.id === id && frame.type === type);

            if (found !== undefined) {
                return Promise.resolve(found);
            }

            return new Promise((resolve) => {
                const frameKey = key(id, type);
                const callbacks = waiters.get(frameKey) ?? [];
                callbacks.push(resolve);
                waiters.set(frameKey, callbacks);
            });
        },
    };
};

const fakeState = (): unknown => {
    const sockets: FakeSocket[] = [];

    return {
        acceptWebSocket(socket: WebSocket) {
            sockets.push(socket as unknown as FakeSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        id: { name: "lazy-ingress-test" },
        storage: {
            sql: {
                exec: () => {
                    return {
                        one: () => undefined,
                        toArray: () => [],
                        [Symbol.iterator]: () => [][Symbol.iterator](),
                    };
                },
            },
        },
    };
};

const rpc = (functionPath: string, trusted = false): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", ...(trusted ? { "x-lunora-system": "1" } : {}) },
        method: "POST",
    });

describe("lazy generated shard at real base ingress", () => {
    afterEach(() => {
        if (stateKey !== undefined) {
            Reflect.deleteProperty(globalThis, stateKey);
            stateKey = undefined;
        }

        if (projectRoot !== undefined) {
            rmSync(projectRoot, { force: true, recursive: true });
            projectRoot = undefined;
        }
    });

    it("rejects external internals before import and keeps RPC trust out of WebSocket preparation", async () => {
        expect.assertions(19);

        stateKey = `__lunoraLazyBaseIngress${randomUUID()}`;
        let signalSystemStarted!: () => void;
        const systemStarted = new Promise<void>((resolve) => {
            signalSystemStarted = resolve;
        });
        const state = {
            privateImports: 0,
            publicImports: 0,
            publicSubImports: 0,
            publicStreamImports: 0,
            systemImports: 0,
            signalSystemStarted,
            releaseSystem: undefined as (() => void) | undefined,
        };

        Reflect.set(globalThis, stateKey, state);

        const functions = [
            makeFunction("private", "read", { visibility: "internal" }),
            makeFunction("private", "stream", { kind: "stream", visibility: "internal" }),
            makeFunction("publicRpc", "read"),
            makeFunction("publicSub", "read"),
            makeFunction("publicStream", "stream", { kind: "stream" }),
            makeFunction("system", "tick", { visibility: "internal" }),
        ];
        const { entry, output: shardFile, root } = writeGeneratedShard(functions);
        const internalState = JSON.stringify(stateKey);

        writeFileSync(
            join(root, "lunora", "private.ts"),
            `const state = globalThis[${internalState}];
state.privateImports += 1;
throw new Error("internal module evaluated");
export const read = { args: {}, kind: "query", handler: () => "private" };
export const stream = { args: {}, kind: "stream", handler: () => (async function* () {})() };
`,
        );
        writeFileSync(
            join(root, "lunora", "publicRpc.ts"),
            `const state = globalThis[${internalState}];
state.publicImports += 1;
export const read = { args: {}, kind: "query", handler: () => "public rpc" };
`,
        );
        writeFileSync(
            join(root, "lunora", "publicSub.ts"),
            `const state = globalThis[${internalState}];
state.publicSubImports += 1;
export const read = { args: {}, kind: "query", handler: () => "public subscription" };
`,
        );
        writeFileSync(
            join(root, "lunora", "publicStream.ts"),
            `const state = globalThis[${internalState}];
state.publicStreamImports += 1;
export const stream = { args: {}, kind: "stream", handler: () => (async function* () { yield "public chunk"; })() };
`,
        );
        writeFileSync(
            join(root, "lunora", "system.ts"),
            `const state = globalThis[${internalState}];
state.systemImports += 1;
export const tick = { args: {}, kind: "query", handler: async () => {
  state.signalSystemStarted();
  await new Promise((resolve) => { state.releaseSystem = resolve; });
  return "trusted";
} };
`,
        );

        // Bundle dependencies because the temporary output has no workspace package resolution.
        await build({
            alias: { "@lunora/do": new URL("../../do/src/index.ts", import.meta.url).pathname },
            bundle: true,
            entryPoints: [entry],
            format: "esm",
            nodePaths: [
                new URL("../node_modules", import.meta.url).pathname,
                new URL("../../do/node_modules", import.meta.url).pathname,
                new URL("../../../node_modules", import.meta.url).pathname,
            ],
            outfile: shardFile,
            platform: "node",
            target: "node22",
        });

        const module = (await import(pathToFileURL(shardFile).href)) as { createShardDO: () => GeneratedShardClass };
        const ShardClass = module.createShardDO();
        const shard = new ShardClass(fakeState(), {});
        const external = await shard.fetch(rpc("private:read"));

        expect(external.status).toBe(404);
        await expect(external.json()).resolves.toMatchObject({ error: { code: "FUNCTION_NOT_FOUND" } });
        expect(state.privateImports).toBe(0);

        const publicRpcResponse = await shard.fetch(rpc("publicRpc:read"));

        expect(publicRpcResponse.status).toBe(200);
        expect(state.publicImports).toBe(1);
        await expect(publicRpcResponse.json()).resolves.toMatchObject({ result: "public rpc" });

        const systemResponse = shard.fetch(rpc("system:tick", true));

        await systemStarted;

        expect(state.systemImports).toBe(1);

        const socket = fakeSocket();
        try {
            await shard.webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ id: "private-sub", query: { args: {}, functionPath: "private:read" }, type: "subscribe" }),
            );
            await shard.webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ id: "private-stream", query: { args: {}, functionPath: "private:stream" }, type: "stream" }),
            );

            expect(state.privateImports).toBe(0);
            expect(
                socket.frames.map(({ id, type }) => {
                    return { id, type };
                }),
            ).toEqual([
                { id: "private-sub", type: "ack" },
                { id: "private-stream", type: "error" },
            ]);
            expect(socket.frames.some(({ type }) => type === "data" || type === "delta")).toBe(false);

            await shard.webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ id: "public-sub", query: { args: {}, functionPath: "publicSub:read" }, type: "subscribe" }),
            );

            expect(state.publicSubImports).toBe(1);
            expect(socket.frames.find(({ id, type }) => id === "public-sub" && type === "data")).toMatchObject({ data: "public subscription" });

            const publicStreamComplete = socket.waitForFrame("public-stream", "complete");
            await shard.webSocketMessage(
                socket as unknown as WebSocket,
                JSON.stringify({ id: "public-stream", query: { args: {}, functionPath: "publicStream:stream" }, type: "stream" }),
            );
            await publicStreamComplete;

            expect(state.publicStreamImports).toBe(1);
            expect(socket.frames.find(({ id, type }) => id === "public-stream" && type === "chunk")).toMatchObject({ data: "public chunk" });
        } finally {
            state.releaseSystem?.();
        }

        const trustedResponse = await systemResponse;

        expect(trustedResponse.status).toBe(200);
        await expect(trustedResponse.json()).resolves.toMatchObject({ result: "trusted" });

        const publicResponse = await shard.fetch(rpc("publicRpc:read"));

        expect(publicResponse.status).toBe(200);
        expect(state.publicImports).toBe(1);
        await expect(publicResponse.json()).resolves.toMatchObject({ result: "public rpc" });
    });
});
