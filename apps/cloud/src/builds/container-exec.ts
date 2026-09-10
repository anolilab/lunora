/**
 * Reading the build box's NDJSON reply (GAPS.md A3).
 *
 * Lives beside `runner.ts` and `dispatch.ts` rather than in `lunora/builds.ts`
 * for the same reason they do: it is the part with logic worth testing, and the
 * lunora module is the part that only wires ports together. The chunk handling
 * in particular needs a test — a JSON object split across two reads is the
 * normal case for a streaming body, not an edge one.
 */
import { LunoraError } from "@lunora/server";

import type { BuildExecution } from "./runner";

/**
 * One line of the build box's NDJSON.
 *
 * `error` and `bundle` are terminal; `line` is progress. Split out from the
 * reader below so the stream plumbing and the protocol stay separately
 * readable — together they were one function nobody would want to change.
 */
const consumeBuildLine = async (line: string, onLine: (line: string) => Promise<void>): Promise<BuildExecution | undefined> => {
    let payload: { bundle?: string; bundleHash?: string; error?: string; line?: string };

    try {
        payload = JSON.parse(line) as typeof payload;
    } catch {
        // A malformed line is the container's problem, not the build's.
        // Surfacing it as a log line beats failing a build that may yet
        // succeed, and an operator sees it either way.
        await onLine(`build box emitted a line that was not JSON: ${line.slice(0, 200)}`);

        return undefined;
    }

    if (typeof payload.error === "string") {
        throw new LunoraError("INTERNAL", payload.error);
    }

    if (typeof payload.bundle === "string" && typeof payload.bundleHash === "string") {
        return { bundle: payload.bundle, bundleHash: payload.bundleHash };
    }

    if (typeof payload.line === "string") {
        await onLine(payload.line);
    }

    return undefined;
};

/**
 * Drive one build through the build box and read its NDJSON back.
 *
 * The container answers `200` as soon as it starts, then writes one JSON object
 * per line: `{"line"}` while the build runs, and a final `{"bundle","bundleHash"}`
 * or `{"error"}`. Streaming rather than a buffered reply is what puts a build's
 * output in `buildLogs` while it is still running — the live tail the Studio's
 * Builds tab is built around — and it sidesteps the exec contract's 1MB
 * response cap, which a real build log passes easily.
 *
 * `TextDecoder` with `{ stream: true }` rather than `TextDecoderStream`: the
 * latter is not in the Node floor this package declares, and a multi-byte
 * character split across two chunks has to survive either way.
 */
export const executeInContainer = async (
    handle: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
    source: ArrayBuffer,
    onLine: (line: string) => Promise<void>,
): Promise<BuildExecution> => {
    const response = await handle.fetch("/__lunora/build", { body: source, method: "POST" });

    if (!response.ok || response.body === null) {
        throw new LunoraError("INTERNAL", `build box answered ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let execution: BuildExecution | undefined;

    // Read to the end even after the bundle arrives: abandoning the stream
    // cancels the container's response, and the last lines — the ones
    // explaining a failure — are exactly the ones that would be lost.
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- reading a stream is inherently sequential
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffered += decoder.decode(value, { stream: true });

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        for (const line of lines.filter((candidate) => candidate.trim() !== "")) {
            // eslint-disable-next-line no-await-in-loop -- log lines must land in order
            execution = (await consumeBuildLine(line, onLine)) ?? execution;
        }
    }

    if (execution === undefined) {
        // The stream ended with neither a bundle nor an error: the container
        // died mid-build (OOM being the likely one). Saying so beats a type
        // error three frames later on an undefined bundle.
        throw new LunoraError("INTERNAL", "the build box closed the stream without producing a bundle or an error");
    }

    return execution;
};
