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

/**
 * Parse one V8 stack line — `at fn (file.js:3:9)` or `at file.js:3:9` — or
 * `undefined` for a line without a location. String slicing rather than a
 * regex: the input is an arbitrary error's stack, and a backtracking pattern
 * over it is a ReDoS.
 */
const parseFrame = (line: string): StackFrame | undefined => {
    const trimmed = line.trim();

    if (!trimmed.startsWith("at ")) {
        return undefined;
    }

    let location = trimmed.slice(3);
    let name = "<anonymous>";
    const open = location.lastIndexOf(" (");

    if (location.endsWith(")") && open !== -1) {
        name = location.slice(0, open);
        location = location.slice(open + 2, -1);
    }

    const colonBeforeColumn = location.lastIndexOf(":");
    const colonBeforeLine = colonBeforeColumn <= 0 ? -1 : location.lastIndexOf(":", colonBeforeColumn - 1);
    const lineno = Number.parseInt(location.slice(colonBeforeLine + 1, colonBeforeColumn), 10);
    const colno = Number.parseInt(location.slice(colonBeforeColumn + 1), 10);

    if (colonBeforeLine <= 0 || Number.isNaN(lineno) || Number.isNaN(colno)) {
        return undefined;
    }

    return { colno, filename: location.slice(0, colonBeforeLine), function: name, lineno };
};

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
        const frame = parseFrame(line);

        if (frame !== undefined) {
            frames.push(frame);
        }
    }

    return frames.toReversed();
};

export type { ReportedError, StackFrame };
