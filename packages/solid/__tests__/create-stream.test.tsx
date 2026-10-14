import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { CreateStreamResult } from "../src/create-stream";
import { createStream } from "../src/create-stream";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

describe(createStream, () => {
    it("opens a stream on setup and appends chunks as they arrive", async () => {
        const fake = createFakeClient();
        let latest: CreateStreamResult<unknown> | undefined;

        render(
            () => {
                latest = createStream(makeStreamRef(TICK_REF), { since: 0 });

                return <pre>{latest.status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The stream opens immediately and reports `streaming` while un-drained.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([TICK_REF]);
        expect(latest?.status()).toBe("streaming");

        fake.pushStream(TICK_REF, { since: 0 }, { tick: 1 });
        fake.pushStream(TICK_REF, { since: 0 }, { tick: 2 });
        await fake.flush();

        expect(latest?.chunks()).toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        fake.streamCalls[0]?.handle.complete();
        await fake.flush();

        expect(latest?.status()).toBe("complete");
    });

    it("forwards `durable` to the client so a reconnect resumes the run", () => {
        const fake = createFakeClient();

        render(
            () => {
                const result = createStream(makeStreamRef(TICK_REF), { since: 0 }, { durable: true });

                return <pre>{result.status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // `{ durable: true }` is what makes a dropped socket resume the same run
        // instead of failing with `STREAM_DISCONNECTED`. The client reads it off the
        // stream options, so a primitive that does not forward it silently gives the
        // caller a non-durable stream — which only shows up on a reconnect.
        expect(fake.streamCalls[0]?.options.durable).toBe(true);
    });

    it('"skip" keeps the primitive mounted without opening a stream', () => {
        const fake = createFakeClient();
        let latest: CreateStreamResult<unknown> | undefined;

        render(
            () => {
                latest = createStream(makeStreamRef(TICK_REF), "skip");

                return <pre>{latest.status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.streamCalls).toHaveLength(0);
        expect(latest?.status()).toBe("idle");
        expect(latest?.chunks()).toStrictEqual([]);
    });

    it("cancels the in-flight iterator when the tree unmounts", () => {
        const fake = createFakeClient();

        const { unmount } = render(
            () => {
                const { status } = createStream(makeStreamRef(TICK_REF), { since: 0 });

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.streamCalls).toHaveLength(1);

        unmount();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
    });

    it("surfaces a server error and transitions status to 'error'", async () => {
        const fake = createFakeClient();
        let latest: CreateStreamResult<unknown> | undefined;

        render(
            () => {
                latest = createStream(makeStreamRef(TICK_REF), { since: 0 });

                return <pre>{latest.status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.streamCalls[0]?.handle.fail(new Error("forbidden"));
        await fake.flush();

        expect(latest?.status()).toBe("error");
        expect(latest?.error()?.message).toBe("forbidden");
    });
});
