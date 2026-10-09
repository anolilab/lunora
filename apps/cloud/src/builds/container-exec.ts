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
import type { BuildAdvisory, BuildExecution, BuildPlace } from "./runner";
import { MAX_BUILD_ADVISORIES } from "./runner";

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
    const { assets, cronSpecs, manifest, scriptName, workspacePackages } = payload;
    const crons = Array.isArray(cronSpecs) ? cronSpecs.filter((cron): cron is string => typeof cron === "string") : [];

    return {
        ...(assets === undefined ? {} : { assets }),
        bundle: payload.bundle,
        bundleHash: payload.bundleHash,
        ...(crons.length > 0 ? { cronSpecs: crons } : {}),
        ...(isRecord(manifest) ? { manifest } : {}),
        ...(typeof scriptName === "string" && scriptName !== "" ? { scriptName } : {}),
        // All or nothing: a list with a malformed entry is not the whole set, and a partial set skips deploys.
        ...(Array.isArray(workspacePackages) && workspacePackages.every((path) => typeof path === "string") ? { workspacePackages } : {}),
    };
};

/** Field caps for an advisory record: it comes from a box that ran tenant code, so nothing in it is trusted. */
const ADVISORY_FIELD_LIMITS = { cacheKey: 600, detail: 2000, file: 512, name: 64, remediation: 1000, title: 200 } as const;

/** Longest build-log line stored — the box caps its own output lines to the same. */
const MAX_LOG_LINE_CHARS = 8000;

/** Detector names are snake_case identifiers; anything else is not a record this plane knows. */
const ADVISORY_NAME = /^[a-z][a-z0-9_]*$/u;

/**
 * An `{"advisory"}` record as a {@link BuildAdvisory}, or `undefined` when it is
 * malformed. Every string is required and truncated to its cap, the line must be
 * a positive integer, and the level is `INFO` or else `WARN` — the scan never fails a build.
 */
const toAdvisory = (value: unknown): BuildAdvisory | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    const fields: Partial<Record<keyof typeof ADVISORY_FIELD_LIMITS, string>> = {};

    for (const [key, limit] of Object.entries(ADVISORY_FIELD_LIMITS) as [keyof typeof ADVISORY_FIELD_LIMITS, number][]) {
        const field = value[key];

        if (typeof field !== "string" || field === "") {
            return undefined;
        }

        fields[key] = field.slice(0, limit);
    }

    const { line, location } = value;

    if (!Number.isInteger(line) || (line as number) < 1 || !ADVISORY_NAME.test(fields.name ?? "")) {
        return undefined;
    }

    return {
        cacheKey: fields.cacheKey ?? "",
        detail: fields.detail ?? "",
        file: fields.file ?? "",
        level: value["level"] === "INFO" ? "INFO" : "WARN",
        line: line as number,
        ...(location === "bundle" || location === "source" ? { location } : {}),
        name: fields.name ?? "",
        remediation: fields.remediation ?? "",
        title: fields.title ?? "",
    };
};

/**
 * One line of the build box's NDJSON.
 *
 * `error` and the release (`bundle` + `bundleHash` + the rest) are terminal;
 * `line` is progress and `advisory` a bundle-scan finding, handed to
 * `onAdvisory` (a malformed one is dropped: it is a warning, not the build's
 * problem). Split out from the reader below so the stream plumbing and the
 * protocol stay separately readable — together they were one function nobody
 * would want to change.
 */
const consumeBuildLine = async (
    line: string,
    onLine: (line: string) => Promise<void>,
    onAdvisory: (advisory: BuildAdvisory) => Promise<void>,
): Promise<BuildExecution | undefined> => {
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
        // Bounded here too: the box ran tenant code, and `buildLogs` rows are not.
        await onLine(payload["line"].slice(0, MAX_LOG_LINE_CHARS));
    }

    const advisory = "advisory" in payload ? toAdvisory(payload["advisory"]) : undefined;

    if (advisory !== undefined) {
        await onAdvisory(advisory);
    }

    return undefined;
};

/**
 * Drive one build through the build box and read its NDJSON back.
 *
 * The container answers `200` as soon as it starts, then writes one JSON object
 * per line: `{"line"}` while the build runs, and a final release
 * (`{"bundle","bundleHash","manifest","assets"?,"cronSpecs"?,"scriptName"?,"workspacePackages"?}`) or
 * `{"error"}`, with an `{"advisory"}` record per bundle-scan finding before the
 * release (at most {@link MAX_BUILD_ADVISORIES} are forwarded). Streaming rather than a buffered reply is what puts a build's
 * output in `buildLogs` while it is still running — the live tail the Studio's
 * Builds tab is built around — and it sidesteps the exec contract's 1MB
 * response cap, which a real build log passes easily.
 */
export const executeInContainer = async (
    handle: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
    source: ArrayBuffer,
    place: BuildPlace | undefined,
    onLine: (line: string) => Promise<void>,
    onAdvisory: (advisory: BuildAdvisory) => Promise<void> = async () => {},
): Promise<BuildExecution> => {
    // Query parameters rather than headers: a directory name is not
    // guaranteed to be header-safe ASCII, and URLSearchParams encodes anything.
    // The build box re-validates both; nothing here is trusted over there.
    const query = new URLSearchParams({
        ...(place?.rootDirectory ? { rootDirectory: place.rootDirectory } : {}),
        ...(place?.runtime === undefined ? {} : { runtime: place.runtime }),
    }).toString();
    const path = query === "" ? "/__lunora/build" : `/__lunora/build?${query}`;
    const response = await handle.fetch(path, { body: source, method: "POST" });

    if (!response.ok || response.body === null) {
        throw new LunoraError("INTERNAL", `build box answered ${String(response.status)}`);
    }

    let execution: BuildExecution | undefined;
    let advisories = 0;
    const forward = async (advisory: BuildAdvisory): Promise<void> => {
        advisories += 1;

        if (advisories <= MAX_BUILD_ADVISORIES) {
            await onAdvisory(advisory);
        }
    };

    await readNdjson(response.body, async (line) => {
        execution = (await consumeBuildLine(line, onLine, forward)) ?? execution;
    });

    if (execution === undefined) {
        // The stream ended with neither a bundle nor an error: the container
        // died mid-build (OOM being the likely one). Saying so beats a type
        // error three frames later on an undefined bundle.
        throw new LunoraError("INTERNAL", "the build box closed the stream without producing a bundle or an error");
    }

    return execution;
};
