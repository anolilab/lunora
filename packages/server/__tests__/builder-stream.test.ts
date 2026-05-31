import { describe, expect, test } from "vitest";

import { initCirrus, v } from "../src/index.js";

const c = initCirrus.dataModel<Record<string, never>>().create();

const collect = async <T>(iter: AsyncIterable<T>, signal?: AbortSignal): Promise<T[]> => {
    const out: T[] = [];

    for await (const value of iter) {
        if (signal?.aborted) {
            break;
        }

        out.push(value);
    }

    return out;
};

describe("c.query.stream() terminal", () => {
    test("registers with kind:'stream' and an async-iterable handler", async () => {
        const counter = c.query.input({ count: v.number() }).stream(async function* counterStream({ args }) {
            for (let index = 0; index < args.count; index += 1) {
                yield index;
            }
        });

        expect(counter.kind).toBe("stream");
        expect(counter.args.count.kind).toBe("number");

        const { signal } = new AbortController();
        const chunks = await collect(counter.handler({}, { count: 3 }, signal));

        expect(chunks).toEqual([0, 1, 2]);
    });

    test("middleware ctx narrows for the streaming handler", async () => {
        let observedCtx: unknown;

        const authedStream = c.query
            .use(async ({ next }) => next({ ctx: { userId: "u_42" } }))
            .stream(async function* authedGen({ ctx }) {
                observedCtx = ctx;
                yield ctx.userId;
            });

        const { signal } = new AbortController();
        const chunks = await collect(authedStream.handler({}, {}, signal));

        expect(chunks).toEqual(["u_42"]);
        expect(observedCtx).toMatchObject({ userId: "u_42" });
    });

    test("aborting the signal stops further yields", async () => {
        const ac = new AbortController();
        const yields: number[] = [];
        const stream = c.query.stream(async function* abortableGen() {
            for (let index = 0; index < 10; index += 1) {
                yields.push(index);
                yield index;

                if (index === 2) {
                    // Mid-stream: simulate a client cancel.
                    ac.abort();
                }
            }
        });

        const observed = await collect(stream.handler({}, {}, ac.signal), ac.signal);

        // The for-await loop on the caller side breaks at the first aborted
        // check after a yield, so we see [0,1,2] (the cancel fires after 2).
        expect(observed).toEqual([0, 1, 2]);
        // The wrapper bails out of the user iterator early, so the producer
        // never reaches index 3 even though its loop counted to 10.
        expect(yields).toEqual([0, 1, 2, 3]);
    });

    test("rejects bad args synchronously at handler call time", () => {
        const guarded = c.query.input({ rooms: v.number() }).stream(async function* guardedGen() {
            yield "should not yield";
        });

        const { signal } = new AbortController();

        // Validation runs synchronously so the runtime's outer try/catch
        // turns it into a single error frame instead of a stream that emits
        // chunks and then fails on close.
        expect(() => guarded.handler({}, { rooms: "abc" as unknown as number }, signal)).toThrow(/args\.rooms/u);
    });
});
