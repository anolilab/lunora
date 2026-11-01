/**
 * Real-workerd check that the lazy function registry's cold load (plan 490 §4, #1166) admits no interleaving the
 * eager registry does not.
 *
 * Lost updates are ruled out by the single-writer gate, not by the load: every mutation body runs inside
 * `runInTransaction`, which the load sits in front of. What the load can change is ADMISSION ORDER. workerd returns
 * to its event loop on every dynamic `import()`, so without `holdShardWhileLoading` a request pipelined behind a cold
 * one on the same stub (E-order) overtakes it: a query misses the client's own write, and two cold mutations commit
 * out of order. Those are the assertions here, against each loader shape a deployment produces (see
 * `./lazy-gate/worker.ts`), with `eager/*` as the control. The hold must stay off the warm path, which the per-module
 * hold and loader counts pin.
 *
 * Only runs with `LUNORA_WORKERD_TESTS=1` (see `packages/do/vitest.config.ts`).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Frame {
    data?: unknown;
    id?: string;
    type: string;
}

interface ModuleStats {
    evaluations: number;
    holds: number;
    loads: number;
}

const rpc = (stub: DurableObjectStub, functionPath: string, args: Record<string, unknown>, mutationId?: string): Promise<Response> =>
    stub.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers: { "content-type": "application/json", ...(mutationId === undefined ? {} : { "x-lunora-mutation-id": mutationId }) },
            method: "POST",
        }),
    );

const resultOf = async <T>(response: Promise<Response>): Promise<T> => {
    const settled = await response;
    const body = await settled.json<{ result: T }>();

    if (!settled.ok) {
        throw new Error(`rpc failed with ${String(settled.status)}: ${JSON.stringify(body)}`);
    }

    return body.result;
};

const statsOf = async (stub: DurableObjectStub, moduleId: string): Promise<ModuleStats | undefined> => {
    const stats = await resultOf<Record<string, ModuleStats>>(rpc(stub, "lazy:stats", { modules: [moduleId] }));

    return stats[moduleId];
};

// A fresh object per test: Miniflare keeps the SQLite file between runs, and modules stay loaded for the isolate's
// lifetime, so each test also owns the modules it cold-loads.
const freshShard = (label: string): DurableObjectStub => env.LAZY_SHARD.get(env.LAZY_SHARD.idFromName(`${label}-${crypto.randomUUID()}`));

/** A socket whose `next` resolves on the first frame (already received or still to come) matching the predicate. */
const openSocket = async (
    stub: DurableObjectStub,
): Promise<{ close: () => void; next: (match: (frame: Frame) => boolean) => Promise<Frame>; send: (frame: unknown) => void }> => {
    const upgrade = await stub.fetch("https://shard.internal/_ws", { headers: { Upgrade: "websocket" } });
    const socket = upgrade.webSocket;

    if (!socket) {
        throw new Error(`expected a websocket upgrade, got ${String(upgrade.status)}`);
    }

    const received: Frame[] = [];
    const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];

    socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
            return;
        }

        const frame = JSON.parse(event.data) as Frame;

        received.push(frame);

        for (const waiter of waiters.filter(({ match }) => match(frame))) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
        }
    });
    socket.accept();

    return {
        close: () => {
            socket.close();
        },
        next: async (match) => {
            const seen = received.find((frame) => match(frame));

            return (
                seen ??
                (await new Promise<Frame>((resolve) => {
                    waiters.push({ match, resolve });
                }))
            );
        },
        send: (frame) => {
            socket.send(JSON.stringify(frame));
        },
    };
};

describe.each(["import", "bundled", "eager"])("lazy registry ingress under real workerd (%s modules)", (shape) => {
    const coldLoads = shape === "eager" ? 0 : 1;

    it("serialises concurrent read-modify-write mutations on a cold module and evaluates it once", async () => {
        expect.assertions(3);

        const stub = freshShard(`${shape}-inc`);
        const total = 24;
        const values = await Promise.all(
            Array.from(
                { length: total },
                async (_, index) => await resultOf<{ value: number }>(rpc(stub, `${shape}/inc:run`, { key: "k", tag: String(index) }, `inc-${String(index)}`)),
            ),
        );

        expect(values.map(({ value }) => value).toSorted((a, b) => a - b)).toStrictEqual(Array.from({ length: total }, (_, index) => index + 1));
        await expect(resultOf(rpc(stub, "eager/sub:run", { key: "k" }))).resolves.toStrictEqual({ value: total });
        await expect(statsOf(stub, `${shape}/inc`)).resolves.toStrictEqual({ evaluations: 1, holds: coldLoads, loads: coldLoads });
    });

    it("commits mutations racing on two cold modules in arrival order", async () => {
        expect.assertions(2);

        const stub = freshShard(`${shape}-race`);
        const tags = Array.from({ length: 12 }, (_, index) => String(index));
        // Sent back to back with no await between them, so each is in flight while the ones before it may still be loading.
        const pending = tags.map(
            async (tag, index) => await resultOf(rpc(stub, `${shape}/race-${index % 2 === 0 ? "x" : "y"}:run`, { key: "k", tag }, `race-${tag}`)),
        );

        await Promise.all(pending);

        await expect(resultOf(rpc(stub, "lazy:log", { key: "k" }))).resolves.toStrictEqual(tags);
        await expect(Promise.all([statsOf(stub, `${shape}/race-x`), statsOf(stub, `${shape}/race-y`)])).resolves.toStrictEqual([
            { evaluations: 1, holds: coldLoads, loads: coldLoads },
            { evaluations: 1, holds: coldLoads, loads: coldLoads },
        ]);
    });

    it("lets a query pipelined behind a cold mutation read that mutation's write", async () => {
        expect.assertions(2);

        const stub = freshShard(`${shape}-ryw`);
        const write = resultOf<{ value: number }>(rpc(stub, `${shape}/ryw:run`, { key: "k", tag: "w" }, "ryw-write"));
        const read = resultOf<{ value: number }>(rpc(stub, "eager/sub:run", { key: "k" }));

        await expect(read).resolves.toStrictEqual({ value: 1 });
        await expect(write).resolves.toStrictEqual({ value: 1 });
    });

    it("keeps warm calls off the hold and the loader", async () => {
        expect.assertions(2);

        const stub = freshShard(`${shape}-warm`);

        await resultOf(rpc(stub, `${shape}/warm:run`, { key: "k", tag: "cold" }, "warm-cold"));

        const warm = await Promise.all(
            Array.from(
                { length: 8 },
                async (_, index) =>
                    await resultOf<{ value: number }>(rpc(stub, `${shape}/warm:run`, { key: "k", tag: String(index) }, `warm-${String(index)}`)),
            ),
        );

        expect(warm).toHaveLength(8);
        await expect(statsOf(stub, `${shape}/warm`)).resolves.toStrictEqual({ evaluations: 1, holds: coldLoads, loads: coldLoads });
    });

    it("seeds a subscription on a cold query and re-runs it warm after a write", async () => {
        expect.assertions(3);

        const stub = freshShard(`${shape}-sub`);
        const socket = await openSocket(stub);

        socket.send({ id: "s1", query: { args: { key: "k" }, functionPath: `${shape}/sub:run` }, type: "subscribe" });

        await expect(socket.next((frame) => frame.id === "s1" && frame.type === "data")).resolves.toMatchObject({ data: { value: 0 } });

        await resultOf(rpc(stub, "eager/warm:run", { key: "k", tag: "w" }, "sub-write"));

        await expect(
            socket.next((frame) => frame.id === "s1" && frame.type === "data" && (frame.data as { value: number }).value === 1),
        ).resolves.toMatchObject({
            data: { value: 1 },
        });

        socket.close();

        await expect(statsOf(stub, `${shape}/sub`)).resolves.toStrictEqual({ evaluations: 1, holds: coldLoads, loads: coldLoads });
    });

    it("opens a stream on a cold module, then again warm", async () => {
        expect.assertions(3);

        const stub = freshShard(`${shape}-tick`);
        const socket = await openSocket(stub);
        const chunks = async (id: string): Promise<unknown[]> => {
            const seen: unknown[] = [];
            const complete = socket.next((frame) => {
                if (frame.id === id && frame.type === "chunk") {
                    seen.push(frame.data);
                }

                return frame.id === id && frame.type === "complete";
            });

            socket.send({ id, query: { functionPath: `${shape}/tick:run` }, type: "stream" });
            await complete;

            return seen;
        };

        await expect(chunks("t1")).resolves.toStrictEqual([{ tick: 1 }, { tick: 2 }]);
        await expect(chunks("t2")).resolves.toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        socket.close();

        await expect(statsOf(stub, `${shape}/tick`)).resolves.toStrictEqual({ evaluations: 1, holds: coldLoads, loads: coldLoads });
    });
});
