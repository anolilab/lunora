/**
 * The events a catalog install streams back, one JSON object per line (NDJSON). The
 * install route writes them and the install form reads them, so both sides share one
 * shape and one parser. The stream always ends with a `result` or an `error` event.
 */
import type { InstallPhase } from "./install";

/** One step the install reached, or how it ended. */
export type InstallEvent =
    | { event: "phase"; phase: InstallPhase }
    | { deploymentId: string; event: "result"; generated: string[]; kept: string[]; recorded: boolean; url?: string }
    | { code?: string; error: string; event: "error"; field?: string; status: number };

/** One event as the single line the stream carries. */
export const encodeInstallEvent = (event: InstallEvent): string => `${JSON.stringify(event)}\n`;

const parseLine = (line: string): InstallEvent => {
    try {
        return JSON.parse(line) as InstallEvent;
    } catch {
        return { error: "the install sent an event that could not be read", event: "error", status: 502 };
    }
};

/**
 * Split the text received so far into the complete events it holds. A line the chunk
 * ends in the middle of is kept as `rest`, to be joined onto the next chunk.
 */
export const takeInstallEvents = (pending: string, chunk: string): { events: InstallEvent[]; rest: string } => {
    const lines = `${pending}${chunk}`.split("\n");
    const rest = lines.pop() ?? "";
    const events = lines.filter((line) => line.trim() !== "").map((line) => parseLine(line));

    return { events, rest };
};
