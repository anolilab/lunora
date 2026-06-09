import { describe, expect, it } from "vitest";

import { initCirrus, v } from "../src/index";

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
    it("registers with kind:'stream' and an async-iterable handler", async () => {
        expect.hasAssertions();

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

    it("middleware ctx narrows for the streaming handler", async () => {
        expect.assertions(2);

        let observedContext: unknown;

        const authedStream = c.query
            .use(async ({ next }) => next({ ctx: { userId: "u_42" } }))
            .stream(async function* authedGen({ ctx }) {
                observedContext = ctx;
                yield ctx.userId;
            });

        const { signal } = new AbortController();
        const chunks = await collect(authedStream.handler({}, {}, signal));

        expect(chunks).toEqual(["u_42"]);
        expect(observedContext).toMatchObject({ userId: "u_42" });
    });

    it("aborting the signal stops further yields", async () => {
        expect.hasAssertions();

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
        // The producer aborts itself in the SAME step that yields 2 (the
        // `ac.abort()` runs after `yield index` returns). On the next pull it
        // resumes from that point, runs `yields.push(3)` and `yield 3` before
        // the wrapper's abort check fires and drops chunk 3 without forwarding
        // it. So the producer reaches index 3 but no further — an external
        // (non-self) cancel is caught *before* the next `.next()` and never
        // resumes the producer at all.
        expect(yields).toEqual([0, 1, 2, 3]);
    });

    it("rejects bad args synchronously at handler call time", () => {
        expect.assertions(1);

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
