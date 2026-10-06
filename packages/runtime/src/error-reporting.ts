/**
 * Helpers for handing a Lunora error to an error tracker from a sink.
 *
 * A failed RPC's `event.error` and a `ctx.log` line's `event.error` both carry
 * the thrown error as plain data (`name`, `message`, `stack`, `code`) — data,
 * because it crosses from the Durable Object to the worker. These turn that
 * data back into what trackers consume: a throwable for an SDK
 * (`Sentry.captureException(toError(event.error))`), or stack frames for an
 * HTTP ingestion API that wants them parsed (PostHog's `$exception_list`).
 */

/** The error half of an RPC event or a log event — what both helpers accept. */
interface ReportedError {
    code?: string;
    message: string;
    name?: string;
    stack?: string;
}

/** One parsed stack frame. */
interface StackFrame {
    colno: number;
    filename: string;
    /** The function name, or `"<anonymous>"` for a frame V8 printed without one. */
    function: string;
    lineno: number;
}

/** `    at fn (file.js:3:9)` and `    at file.js:3:9` — the V8 stack-line shapes workerd prints. */
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/u;

/**
 * Rebuild a throwable from an event's `error`, carrying the original `name`,
 * `message`, `stack`, and `code`, so an SDK groups it by the handler's real
 * stack rather than by the line that called the SDK.
 */
export const toError = (error: ReportedError): Error => {
    const rebuilt = new Error(error.message) as Error & { code?: string };

    rebuilt.name = error.name ?? error.code ?? "Error";

    if (error.stack !== undefined) {
        rebuilt.stack = error.stack;
    }

    if (error.code !== undefined) {
        rebuilt.code = error.code;
    }

    return rebuilt;
};

/**
 * Parse a V8 stack trace into frames, **oldest call first** — the order Sentry
 * and PostHog expect. Lines that carry no location (`at Array.map (<anonymous>)`,
 * the leading `TypeError: …` line) are skipped; an absent stack yields `[]`.
 */
export const parseStackFrames = (stack: string | undefined): StackFrame[] => {
    if (stack === undefined) {
        return [];
    }

    const frames: StackFrame[] = [];

    for (const line of stack.split("\n")) {
        const match = V8_FRAME.exec(line);

        if (match !== null) {
            frames.push({ colno: Number(match[4]), filename: match[2] as string, function: match[1] ?? "<anonymous>", lineno: Number(match[3]) });
        }
    }

    return frames.toReversed();
};

export type { ReportedError, StackFrame };
