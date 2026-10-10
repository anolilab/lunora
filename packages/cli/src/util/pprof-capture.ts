/**
 * The parts of an on-demand pprof capture that do not depend on where the
 * profile comes from: validating the request, POSTing it, turning a response
 * into bytes or an exit code, and writing the gzip file.
 *
 * A command supplies the endpoint, its credentials, and how its own error
 * bodies read; this module supplies the rest, so every profile command maps
 * failures the same way.
 */
import { resolve } from "node:path";

import { EXIT_CODE, exitCodeForStatus } from "./exit-code";
import type { Logger } from "./logger";
import { writeAtomic } from "./mcp-config-file";

/** The capture types a pprof endpoint accepts. */
const PROFILE_TYPES = ["cpu", "heap"] as const;

type ProfileType = (typeof PROFILE_TYPES)[number];

/** The `duration_ms` bounds the endpoints accept. */
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 50_000;
const DEFAULT_DURATION_MS = 10_000;

/** Slack on top of the capture window for the endpoint to serialise and return the profile. */
const RESPONSE_MARGIN_MS = 30_000;

/** The first two bytes of every gzip stream, which is what a successful capture returns. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

interface ProfileRequest {
    durationMs: number;
    profileType: ProfileType;
}

/**
 * Check the `--type` and `--duration-ms` the user typed, with the defaults
 * applied. The first problem is returned as a usage message.
 */
const validateProfileRequest = (profileType: string | undefined, durationMs: string | undefined): { error: string } | ProfileRequest => {
    const type = profileType ?? "cpu";

    if (!(PROFILE_TYPES as ReadonlyArray<string>).includes(type)) {
        return { error: `profile: invalid --type "${type}" — expected ${PROFILE_TYPES.join(" | ")}` };
    }

    const duration = durationMs === undefined ? DEFAULT_DURATION_MS : Number(durationMs);

    if (!Number.isInteger(duration) || duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
        return {
            error: `profile: invalid --duration-ms "${durationMs ?? ""}" — expected an integer from ${String(MIN_DURATION_MS)} to ${String(MAX_DURATION_MS)}`,
        };
    }

    return { durationMs: duration, profileType: type as ProfileType };
};

/** What `captureProfile` sends. `fetch` is the admin fetch or a test double with the same shape. */
interface CaptureRequestInit {
    body: string;
    headers: Record<string, string>;
    method: string;
    signal: AbortSignal;
}

interface CaptureOptions {
    /** The JSON request body. */
    body: unknown;
    /** Reads a non-2xx body into a short message. Each command knows its own error shape. */
    describeBody: (text: string) => string;
    durationMs: number;
    fetch: (input: string, init: CaptureRequestInit) => Promise<Response>;
    /** Authorization and any other headers. `Content-Type` is always JSON. */
    headers: Record<string, string>;
    /** A hint for a status the user can act on, or `""`. */
    hintForStatus: (status: number) => string;
    logger: Logger;
    url: string;
}

type CaptureOutcome = { bytes: Uint8Array } | { code: number; error: string };

/**
 * POST the capture request and return the gzip bytes. Every failure becomes an
 * exit code: an unreachable or timed-out endpoint (including a timeout while the
 * body is read) is UNAVAILABLE, a refusal maps by its HTTP status, and a 2xx
 * that is not gzip is a plain failure.
 */
const captureProfile = async (options: CaptureOptions): Promise<CaptureOutcome> => {
    options.logger.info(`Profiling ${options.url} for ${String(options.durationMs)} ms — keep traffic flowing to it…`);

    try {
        const response = await options.fetch(options.url, {
            body: JSON.stringify(options.body),
            headers: { ...options.headers, "Content-Type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(options.durationMs + RESPONSE_MARGIN_MS),
        });

        if (!response.ok) {
            const reason = options.describeBody(await response.text());

            return {
                code: exitCodeForStatus(response.status),
                error: `profile failed (HTTP ${String(response.status)})${reason.length > 0 ? `: ${reason}` : ""}${options.hintForStatus(response.status)}.`,
            };
        }

        // Binary gzip: read the bytes, never the text or JSON.
        const bytes = new Uint8Array(await response.arrayBuffer());

        if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
            const reason = options.describeBody(new TextDecoder().decode(bytes));

            return {
                code: EXIT_CODE.FAILURE,
                error: `profile failed: the endpoint answered 200 with something that is not a gzip profile${reason.length > 0 ? `: ${reason}` : ""}.`,
            };
        }

        return { bytes };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return { code: EXIT_CODE.UNAVAILABLE, error: `profile failed: ${reason}.` };
    }
};

/**
 * Write the profile to `out` (resolved against `cwd`), or to `defaultName` in
 * `cwd` when no `out` was given. The write is atomic, so a failure leaves an
 * existing file at that path untouched.
 */
const writeProfile = (cwd: string, out: string | undefined, defaultName: string, bytes: Uint8Array): { error: string } | { file: string } => {
    const file = resolve(cwd, out ?? defaultName);

    try {
        writeAtomic(file, bytes);

        return { file };
    } catch (error) {
        return { error: `could not write ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
};

export type { CaptureOptions, CaptureOutcome, CaptureRequestInit, ProfileRequest, ProfileType };
export { captureProfile, PROFILE_TYPES, validateProfileRequest, writeProfile };
