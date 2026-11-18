import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";

import { resolveShard } from "@lunora/platform";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrainTimer } from "../src/drain-deadline";
import { createNodePlatform } from "../src/node-platform";
import { createNodeShardRegistry } from "../src/node-shard-registry";

/** Each logged line as the console prints it: the format string with its arguments applied. */
const printed = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((args) => format(...args));

/** This package's built entry, which the child-process test runs on plain Node. */
const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs");

/** A promise the test settles by hand: work that is "in flight" until the test says otherwise. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

/** One full event-loop turn: every microtask a non-waiting drain would need to settle has run. */
const turn = async (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve);
    });

describe("shard drain", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("waits for an in-flight onFetch, such as a cron delivery, before the registry reports idle", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));
            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("waits for work a shard handed to waitUntil, and for work a request started there", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: (_request, shard) => {
                const background = async (): Promise<void> => {
                    await gate.promise;
                    events.push("background done");
                };

                shard.shard.waitUntil?.(background());

                return new Response("ok");
            },
        });

        try {
            await registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));

            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await drained;

            expect(events).toStrictEqual(["background done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("includes the registry's shards in the platform's drain", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const platform = createNodePlatform({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = resolveShard(platform.directory, "a").fetch(new Request("https://shard.internal/rpc"));
            const drained = platform.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            platform.close();
        }
    });
});

/** A deadline the test fires by hand: no clock runs in these tests. */
const manualTimer = (): { fire: () => void; timer: DrainTimer } => {
    let onExpire: () => void = () => {};

    return {
        fire: () => {
            onExpire();
        },
        timer: (_ms, expire) => {
            onExpire = expire;

            return () => {
                onExpire = () => {};
            };
        },
    };
};

describe("shard drain passes", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sees waitUntil work added to a shard whose own drain already finished", async () => {
        expect.assertions(2);

        const gateA = deferred();
        const gateB = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry();

        try {
            const shardB = registry.shardFor("b");

            // Shard a's background work, once released, hands new work to shard b, which the first pass already found idle.
            registry.shardFor("a").shard.waitUntil?.(
                (async (): Promise<void> => {
                    await gateA.promise;
                    shardB.shard.waitUntil?.(
                        (async (): Promise<void> => {
                            await gateB.promise;
                            events.push("b done");
                        })(),
                    );
                })(),
            );

            const drained = registry.drain().then((result) => {
                events.push("drained");

                return result;
            });

            gateA.release();
            await turn();
            gateB.release();

            await expect(drained).resolves.toStrictEqual({ pending: [], timedOut: false });
            expect(events).toStrictEqual(["b done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("sees a shard opened while draining", async () => {
        expect.assertions(1);

        const gateA = deferred();
        const gateC = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry();

        try {
            registry.shardFor("a").shard.waitUntil?.(
                (async (): Promise<void> => {
                    await gateA.promise;
                    // A shard that did not exist when the drain began.
                    registry.shardFor("c").shard.waitUntil?.(
                        (async (): Promise<void> => {
                            await gateC.promise;
                            events.push("c done");
                        })(),
                    );
                })(),
            );

            const drained = registry.drain().then(() => events.push("drained"));

            gateA.release();
            await turn();
            gateC.release();
            await drained;

            expect(events).toStrictEqual(["c done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("gives up at the deadline, naming each shard and how much work it still had, never the work itself", async () => {
        expect.assertions(3);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const { fire, timer } = manualTimer();
        const never = deferred();
        const registry = createNodeShardRegistry({
            onFetch: async () => {
                await never.promise;

                return new Response("never");
            },
        });

        try {
            registry.shardFor("stuck").shard.waitUntil?.(never.promise);
            registry.shardFor("stuck").shard.waitUntil?.(never.promise);
            registry.directory
                .getByName("busy")
                .fetch(new Request("https://shard.internal/rpc?token=secret-token-value", { body: '{"card":"4242"}', method: "POST" }))
                .catch(() => undefined);

            const drained = registry.drain({ timer });

            fire();

            const result = await drained;

            expect(result).toStrictEqual({ pending: ["shard busy: 1 request in flight", "shard stuck: 2 waitUntil tasks"], timedOut: true });
            expect(printed(logged)).toContainEqual(expect.stringContaining("shard busy: 1 request in flight, shard stuck: 2 waitUntil tasks"));
            expect(printed(logged).join("\n")).not.toMatch(/secret-token-value|4242/u);
        } finally {
            never.release();
            registry.close();
        }
    });

    it("runs the whole platform drain under one deadline, so one firing ends both the host and the shard waits", async () => {
        expect.assertions(1);

        vi.spyOn(console, "error").mockImplementation(() => {});

        // Keeps only the last callback it was given, as a simple injected clock does: a second deadline would replace the first.
        const { fire, timer } = manualTimer();
        const never = deferred();
        const platform = createNodePlatform();

        try {
            platform.shard.waitUntil?.(never.promise);
            resolveShard(platform.directory, "stuck")
                .fetch(new Request("https://shard.internal/rpc"))
                .catch(() => undefined);

            const drained = platform.drain({ timer });

            fire();

            await expect(drained).resolves.toStrictEqual({ pending: ["waitUntil work on the platform host"], timedOut: true });
        } finally {
            never.release();
            platform.close();
        }
    });

    it("keeps the process alive until the deadline, so a stalled shard cannot end it silently", async () => {
        expect.assertions(2);

        // A child process, because only there can the event loop run empty: the stalled waitUntil has no I/O behind it, so the
        // deadline's own timer is the one thing that can keep the process alive long enough to report.
        const directory = mkdtempSync(join(tmpdir(), "lunora-drain-alive-"));
        const script = join(directory, "drain.mjs");

        writeFileSync(
            script,
            [
                `import { createNodeShardRegistry } from ${JSON.stringify(pathToFileURL(DIST_ENTRY).href)};`,
                "const registry = createNodeShardRegistry();",
                'registry.shardFor("stalled").shard.waitUntil(new Promise(() => {}));',
                "const result = await registry.drain({ timeoutMs: 0 });",
                'console.log("RESULT", JSON.stringify(result));',
            ].join("\n"),
            "utf8",
        );

        try {
            const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";

            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf8");
            });

            const code = await new Promise<number | null>((resolve) => {
                child.once("exit", resolve);
            });

            expect(code).toBe(0);
            expect(stdout).toContain(`RESULT ${JSON.stringify({ pending: ["shard stalled: 1 waitUntil task"], timedOut: true })}`);
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});

describe("background failures", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("logs a rejected waitUntil with the error object, so its stack and cause print", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const registry = createNodeShardRegistry();
        const failure = new Error("background write failed", { cause: new Error("disk full") });

        try {
            registry.shardFor("a").shard.waitUntil?.(Promise.reject(failure));
            await registry.drain();

            expect(printed(logged)).toContainEqual(expect.stringContaining("waitUntil on shard a failed"));
            // The error object itself is the last argument, so the console prints its stack and cause.
            expect((logged.mock.calls[0]?.at(-1) as Error).cause).toStrictEqual(new Error("disk full"));
        } finally {
            registry.close();
        }
    });

    it("logs a scheduled job whose delivery throws, naming the job, before it is retried", async () => {
        expect.assertions(2);

        const failure = new Error("delivery refused");
        const reported = deferred();
        const logged = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
            if (parts.includes(failure)) {
                reported.release();
            }
        });
        const platform = createNodePlatform({
            onDispatch: () => {
                throw failure;
            },
        });

        try {
            await platform.scheduler.schedule("jobs:run", {}, { delayMs: 0, retry: { maxAttempts: 1 } });
            await reported.promise;

            expect(printed(logged)).toContainEqual(expect.stringContaining("scheduled job jobs:run"));
            expect(logged.mock.calls[0]?.at(-1)).toBe(failure);
        } finally {
            platform.close();
        }
    });
});
