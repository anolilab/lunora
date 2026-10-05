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

import readNdjson from "../lib/read-ndjson";
import type { BuildExecution } from "./runner";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The terminal release line, as an execution.
 *
 * Only the shape is checked here — `manifest` an object, `cronSpecs` strings.
 * Everything inside them is validated by the deploy path, exactly as it
 * validates a `POST /v1/deploy` body, so a box that ran tenant code cannot
 * reach the provisioner with anything a CLI upload could not.
 *
 * A line with no `manifest` is still a build — but only an older build-box
 * IMAGE sends one, from before the box collected releases; its build stays
 * green and the release refuses it, saying why. The current box never sends
 * one: it runs the project's own `lunora cloud deploy --out` for the manifest,
 * and a project whose `@lunora/cli` predates `--out` fails its BUILD there with
 * an error naming the upgrade (`containers/build/release.mjs`
 * `releaseFailure`), since a build that can never be released must not read green.
 */
const toExecution = (payload: Record<string, unknown> & { bundle: string; bundleHash: string }): BuildExecution => {
    const { assets, cronSpecs, manifest, scriptName } = payload;
    const crons = Array.isArray(cronSpecs) ? cronSpecs.filter((cron): cron is string => typeof cron === "string") : [];

    return {
        ...(assets === undefined ? {} : { assets }),
        bundle: payload.bundle,
        bundleHash: payload.bundleHash,
        ...(crons.length > 0 ? { cronSpecs: crons } : {}),
        ...(isRecord(manifest) ? { manifest } : {}),
        ...(typeof scriptName === "string" && scriptName !== "" ? { scriptName } : {}),
    };
};

/**
 * One line of the build box's NDJSON.
 *
 * `error` and the release (`bundle` + `bundleHash` + the rest) are terminal;
 * `line` is progress. Split out from the reader below so the stream plumbing
 * and the protocol stay separately readable — together they were one function
 * nobody would want to change.
 */
const consumeBuildLine = async (line: string, onLine: (line: string) => Promise<void>): Promise<BuildExecution | undefined> => {
    let payload: unknown;

    try {
        payload = JSON.parse(line);
    } catch {
        // A malformed line is the container's problem, not the build's.
        // Surfacing it as a log line beats failing a build that may yet
        // succeed, and an operator sees it either way.
        await onLine(`build box emitted a line that was not JSON: ${line.slice(0, 200)}`);

        return undefined;
    }

    if (!isRecord(payload)) {
        return undefined;
    }

    if (typeof payload["error"] === "string") {
        throw new LunoraError("INTERNAL", payload["error"]);
    }

    if (typeof payload["bundle"] === "string" && typeof payload["bundleHash"] === "string") {
        return toExecution({ ...payload, bundle: payload["bundle"], bundleHash: payload["bundleHash"] });
    }

    if (typeof payload["line"] === "string") {
        await onLine(payload["line"]);
    }

    return undefined;
};

/**
 * Drive one build through the build box and read its NDJSON back.
 *
 * The container answers `200` as soon as it starts, then writes one JSON object
 * per line: `{"line"}` while the build runs, and a final release
 * (`{"bundle","bundleHash","manifest","assets"?,"cronSpecs"?,"scriptName"?}`) or
 * `{"error"}`. Streaming rather than a buffered reply is what puts a build's
 * output in `buildLogs` while it is still running — the live tail the Studio's
 * Builds tab is built around — and it sidesteps the exec contract's 1MB
 * response cap, which a real build log passes easily.
 */
export const executeInContainer = async (
    handle: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
    source: ArrayBuffer,
    rootDirectory: string | undefined,
    onLine: (line: string) => Promise<void>,
): Promise<BuildExecution> => {
    // A query parameter rather than a header: a directory name is not
    // guaranteed to be header-safe ASCII, and URLSearchParams encodes anything.
    // The build box re-validates it; nothing here is trusted over there.
    const path = rootDirectory ? `/__lunora/build?${new URLSearchParams({ rootDirectory }).toString()}` : "/__lunora/build";
    const response = await handle.fetch(path, { body: source, method: "POST" });

    if (!response.ok || response.body === null) {
        throw new LunoraError("INTERNAL", `build box answered ${String(response.status)}`);
    }

    let execution: BuildExecution | undefined;

    await readNdjson(response.body, async (line) => {
        execution = (await consumeBuildLine(line, onLine)) ?? execution;
    });

    if (execution === undefined) {
        // The stream ended with neither a bundle nor an error: the container
        // died mid-build (OOM being the likely one). Saying so beats a type
        // error three frames later on an undefined bundle.
        throw new LunoraError("INTERNAL", "the build box closed the stream without producing a bundle or an error");
    }

    return execution;
};
