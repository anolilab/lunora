/**
 * Settle on the next macrotask, after every microtask queued so far and every one those queue.
 * A mocked RPC's continuation is a pure promise chain, so once the test resolves its deferred and
 * this settles, the code under test has either made the write a stale-answer guard exists to drop
 * or dropped it; asserting absence earlier would only prove it had not happened yet.
 */
const drainMicrotasks = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
};

export default drainMicrotasks;
