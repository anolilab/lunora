import { MockLanguageModelV4 } from "ai/test";

/** One provider stream part as a model's `doStream` emits it (`text-delta`, `tool-call`, `finish`, …). */
type ModelStreamResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV4>["doStream"]>>;
type RecordedStreamPart = ModelStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/**
 * A pause point in a recorded turn. The stream emits `after` parts, then stops
 * until {@link StreamGate.release} is called — a test observes or cancels the
 * run while it is mid-stream without sleeping.
 */
interface StreamGate {
    /** Resolves once the stream has reached the gate and is waiting on {@link StreamGate.release}. */
    readonly reached: Promise<void>;

    /** Let the paused stream continue. Idempotent. */
    release: () => void;

    /** Called by the recorded stream when it reaches the gate; the stream resumes after `release`. */
    wait: () => Promise<void>;
}

/** One recorded model call: the stream parts it emits, plus optional pause and failure points. */
interface RecordedTurn {
    /** Fail the stream with `cause` once `after` parts have been emitted (a mid-stream provider error). */
    error?: { after: number; cause: unknown };

    /** The provider stream parts for one model call, in emission order. */
    parts: ReadonlyArray<RecordedStreamPart>;

    /** Pause after `after` parts until `gate` is released. */
    pause?: { after: number; gate: StreamGate };
}

/** Create a {@link StreamGate} to pause a recorded turn on. */
const createStreamGate = (): StreamGate => {
    let markReached: () => void = () => {};
    let open: () => void = () => {};

    const reached = new Promise<void>((resolve) => {
        markReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
        open = resolve;
    });

    return {
        reached,
        release: () => {
            open();
        },
        wait: () => {
            markReached();

            return released;
        },
    };
};

/**
 * Play one recorded turn as a pull-driven stream. `highWaterMark: 0` means a
 * part is produced only when the consumer asks for it, so a pause or an error
 * lands exactly after the N-th part rather than whenever the stream read ahead.
 */
const playTurn = (turn: RecordedTurn): ReadableStream<RecordedStreamPart> => {
    let index = 0;
    let paused = false;

    return new ReadableStream<RecordedStreamPart>(
        {
            pull: async (controller) => {
                if (turn.error?.after === index) {
                    controller.error(turn.error.cause);

                    return;
                }

                if (turn.pause?.after === index && !paused) {
                    paused = true;

                    await turn.pause.gate.wait();
                }

                const part = turn.parts[index];

                if (part === undefined) {
                    controller.close();

                    return;
                }

                index += 1;
                controller.enqueue(part);
            },
        },
        { highWaterMark: 0 },
    );
};

/**
 * A language model that replays recorded stream parts, one {@link RecordedTurn}
 * per model call, in order. Pass it as an agent's `model` (or to
 * `agentHarness(...).run(..., { model })`) to drive the production streaming
 * seam against a recorded stream. Each call pops the next turn; a call past the
 * last recorded turn fails the stream loudly rather than inventing an answer.
 * `doStreamCalls` records the call options each turn was requested with.
 */
const recordedModel = (turns: ReadonlyArray<RecordedTurn>): MockLanguageModelV4 => {
    const remaining = [...turns];

    return new MockLanguageModelV4({
        doStream: () => {
            const turn = remaining.shift();

            // Fail the stream rather than the call: a rejected `doStream` is retried
            // by the SDK, and each retry would consume the next recorded turn.
            const stream = turn
                ? playTurn(turn)
                : new ReadableStream<RecordedStreamPart>({
                      start: (controller) => {
                          controller.error(new Error("recordedModel: the run made more model calls than turns were recorded."));
                      },
                  });

            return Promise.resolve({ stream });
        },
    });
};

export type { RecordedStreamPart, RecordedTurn, StreamGate };
export { createStreamGate, recordedModel };
