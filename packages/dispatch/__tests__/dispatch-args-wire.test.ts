/**
 * The dispatch runner's args wire. `createDispatchRunner` POSTs to
 * `/_lunora/scheduler/dispatch`, the runtime forwards `args` verbatim to the
 * shard's `/rpc`, and the shard's dispatch loop is the one and only decoder
 * (`decodeWire(payload.args ?? {})`, `@lunora/do`'s `shard-do`). These pin the
 * producer half of that bracket: a `bigint` or `Date` argument has to reach the
 * handler as a `bigint` or `Date`, a pure-JSON argument has to be byte-identical
 * on the wire, and a caller that already put its args in wire form has to be
 * left alone — `decodeWire` is not idempotent, so a double encode reaches the
 * handler as a tagged array, and for a `Date` it does so silently.
 */
import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { createDispatchRunner } from "../src/create-dispatch-runner";
import type { FunctionReference } from "../src/types";

const ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example" };
const REF: FunctionReference = { __lunoraRef: "jobs:charge" };

/** Run one dispatch and hand back the POSTed body the way the endpoint parses it. */
const dispatchBody = async (args: Record<string, unknown>, runnerOptions: { argsAlreadyEncoded?: boolean } = {}): Promise<{ args?: unknown }> => {
    let body = "";

    const run = createDispatchRunner({
        env: ENV,
        fetchImpl: async (_url: unknown, init?: RequestInit) => {
            body = init?.body as string;

            return new Response(null, { status: 200 });
        },
        label: "@lunora/queue",
        ...runnerOptions,
    });

    await run(REF, args as never);

    return JSON.parse(body) as { args?: unknown };
};

/** What the shard's single `decodeWire` hands the handler for a dispatch of `args`. */
const handlerArgs = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const body = await dispatchBody(args);

    return decodeWire(body.args ?? {}) as Record<string, unknown>;
};

describe("dispatch runner args wire", () => {
    it("delivers a bigint argument to the handler as a bigint", async () => {
        expect.assertions(2);

        const args = await handlerArgs({ amountCents: 4_294_967_296n });

        expect(typeof args["amountCents"]).toBe("bigint");
        expect(args["amountCents"]).toBe(4_294_967_296n);
    });

    it("delivers a Date argument to the handler as a Date", async () => {
        expect.assertions(2);

        // The type, not merely the absence of a throw: an un-encoded `Date`
        // arrives as an ISO string, which fails nothing until the handler does
        // date arithmetic on it.
        const args = await handlerArgs({ dueAt: new Date("2026-06-01T12:00:00.000Z") });

        expect(args["dueAt"]).toBeInstanceOf(Date);
        expect((args["dueAt"] as Date).toISOString()).toBe("2026-06-01T12:00:00.000Z");
    });

    it("delivers bytes to the handler as bytes", async () => {
        expect.assertions(2);

        const args = await handlerArgs({ blob: new Uint8Array([1, 2, 3]) });

        expect(args["blob"]).toBeInstanceOf(Uint8Array);
        expect([...(args["blob"] as Uint8Array)]).toStrictEqual([1, 2, 3]);
    });

    it("leaves pure-JSON args byte-identical on the wire and at the handler", async () => {
        expect.assertions(2);

        const plain = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null }, note: "hi" };
        const body = await dispatchBody(plain);

        // Identity on the wire: nothing was tagged, so an existing caller's
        // request body is byte for byte what it always was.
        expect(body.args).toStrictEqual(plain);
        await expect(handlerArgs(plain)).resolves.toStrictEqual(plain);
    });

    it("forwards already-encoded args verbatim so the shard's single decode still lands", async () => {
        expect.assertions(2);

        // `@lunora/scheduler`'s queue workpool encodes at `enqueue` because the
        // queue is its own serialising hop, then hands the wire form straight
        // here. Encoding it a second time would leave the shard's single decode
        // a tagged array — and for a `Date`, a `{}`.
        const encoded = encodeWire({ amountCents: 7n, dueAt: new Date("2026-06-01T12:00:00.000Z") }) as Record<string, unknown>;
        const body = await dispatchBody(encoded, { argsAlreadyEncoded: true });

        expect(body.args).toStrictEqual(encoded);

        const args = decodeWire(body.args ?? {}) as Record<string, unknown>;

        expect(args).toStrictEqual({ amountCents: 7n, dueAt: new Date("2026-06-01T12:00:00.000Z") });
    });
});
