/** A fake socket that records what it sent and calls every listener after each send. */
interface FrameSink {
    readonly sendListeners: Set<() => void>;
    readonly sent: string[];
}

type Frame = Record<string, unknown>;

/**
 * Resolves once the frames `ws` has sent satisfy `matches`, checked now and after every later send.
 * A stream pump runs loose of the `webSocketMessage` call that started it, so the frame it sends is
 * the only join point a test has; one that never arrives fails the test on its timeout.
 */
const waitForFrames = async (ws: FrameSink, matches: (frames: Frame[]) => boolean): Promise<void> => {
    const satisfied = (): boolean => matches(ws.sent.map((raw) => JSON.parse(raw) as Frame));

    if (satisfied()) {
        return;
    }

    await new Promise<void>((resolve) => {
        const listener = (): void => {
            if (satisfied()) {
                ws.sendListeners.delete(listener);
                resolve();
            }
        };

        ws.sendListeners.add(listener);
    });
};

export default waitForFrames;
