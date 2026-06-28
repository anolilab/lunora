import { describe, expect, it } from "vitest";

import type { MutatorTransaction } from "../src/mutator-runner";
import { createMutatorRunner } from "../src/mutator-runner";

/** A handle whose `isPersisted` promise the test resolves/rejects manually. */
const deferredHandle = (): { fail: (error: unknown) => void; handle: () => MutatorTransaction; succeed: () => void } => {
    let succeed!: () => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
        succeed = () => {
            resolve(undefined);
        };
        fail = reject;
    });

    return {
        fail,
        handle: () => {
            return { isPersisted: { promise } };
        },
        succeed,
    };
};

describe("createMutatorRunner — latest-invocation error semantics", () => {
    it("does not let an older call's success clear a newer call's error", async () => {
        expect.assertions(1);

        const first = deferredHandle();
        const second = deferredHandle();
        let { handle } = first;
        const errors: (Error | undefined)[] = [];
        const runner = createMutatorRunner(() => handle(), {
            setError: (error) => errors.push(error),
            setPending: () => {},
        });

        const firstCall = runner.mutate({}).catch(() => {});
        handle = second.handle;
        const secondCall = runner.mutate({}).catch(() => {});

        // The newer (second) call fails first, then the older (first) call succeeds.
        second.fail(new Error("boom"));
        await secondCall;
        first.succeed();
        await firstCall;

        // The stale success must NOT have cleared the latest invocation's error.
        expect(errors.at(-1)).toBeInstanceOf(Error);
    });

    it("does not let an older call's failure overwrite a newer call's success", async () => {
        expect.assertions(1);

        const first = deferredHandle();
        const second = deferredHandle();
        let { handle } = first;
        const errors: (Error | undefined)[] = [];
        const runner = createMutatorRunner(() => handle(), {
            setError: (error) => errors.push(error),
            setPending: () => {},
        });

        const firstCall = runner.mutate({}).catch(() => {});
        handle = second.handle;
        const secondCall = runner.mutate({}).catch(() => {});

        // The newer (second) call succeeds first, then the older (first) call fails.
        second.succeed();
        await secondCall;
        first.fail(new Error("boom"));
        await firstCall;

        // The stale failure must NOT have surfaced after the latest call succeeded.
        expect(errors.at(-1)).toBeUndefined();
    });
});
