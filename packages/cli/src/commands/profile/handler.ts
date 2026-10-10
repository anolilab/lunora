/**
 * `lunora profile` — ask a Node-target app for an on-demand CPU or heap profile
 * and save it as a gzip-compressed pprof file.
 *
 * The app serves the capture from the route it mounted `createNodeProfileHandler`
 * on, so `--url` is that full route, not a host. The request is `POST
 * { duration_ms, profile_type }` with the admin bearer. The response is binary
 * and is read with `arrayBuffer()`, never as text or JSON.
 *
 * Only the Node target has an app-side handler. On Cloudflare the same thing is
 * `lunora cloudflare profile`, which this command points to instead of
 * duplicating it.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { capErrorBody } from "../../../../../shared/cap-error-body";
import { resolveAdminBearer } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { ProfileOptions } from "./index";

/** The `duration_ms` bounds the app-side handler accepts. */
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 50_000;
const DEFAULT_DURATION_MS = 10_000;

/** Slack on top of the capture window for the app to serialise and return the profile. */
const RESPONSE_MARGIN_MS = 30_000;

const PROFILE_TYPES = ["cpu", "heap"] as const;

type ProfileType = (typeof PROFILE_TYPES)[number];

/** The first two bytes of every gzip stream, which is what a successful capture returns. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** The target this command serves. */
const NODE_TARGET = "node";

/** Shape of `adminFetch`, which the tests replace. */
type ProfileFetch = typeof adminFetch;

interface ProfileCommandOptions {
    cwd: string;
    /** Capture window in ms, as typed (default 10000). */
    durationMs?: string;
    /** Defaults to the admin fetch; injected in tests. */
    fetchImpl?: ProfileFetch;
    logger: Logger;
    /** Clock for the default file name (tests). */
    now?: Date;
    /** Output file; defaults to `profile-<type>-<timestamp>.pprof.gz` in `cwd`. */
    out?: string;
    /** `cpu` (default) or `heap`, as typed. */
    profileType?: string;
    /** `--target`, or the target the project resolves to. */
    target?: string;
    token?: string;
    /** The full URL of the route the app mounted the handler on. */
    url?: string;
}

interface ProfileData {
    bytes: number;
    durationMs: number;
    file: string;
    profileType: ProfileType;
    url: string;
}

interface ProfileResult {
    code: number;
    data?: ProfileData;
    error?: string;
}

const fail = (logger: Logger, code: number, message: string): ProfileResult => {
    logger.error(message);

    return { code, error: message };
};

/** The request inputs, validated. Returns the first problem, as a usage message. */
const validate = (options: ProfileCommandOptions): { error: string } | { durationMs: number; profileType: ProfileType } => {
    const profileType = options.profileType ?? "cpu";

    if (!(PROFILE_TYPES as ReadonlyArray<string>).includes(profileType)) {
        return { error: `profile: invalid --type "${profileType}" — expected ${PROFILE_TYPES.join(" | ")}` };
    }

    const durationMs = options.durationMs === undefined ? DEFAULT_DURATION_MS : Number(options.durationMs);

    if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
        return {
            error: `profile: invalid --duration-ms "${options.durationMs ?? ""}" — expected an integer from ${String(MIN_DURATION_MS)} to ${String(MAX_DURATION_MS)}`,
        };
    }

    return { durationMs, profileType: profileType as ProfileType };
};

/** The `error.message` of a JSON error body, or the capped raw text when the body is not one. */
const describeBody = (text: string): string => {
    try {
        const body = JSON.parse(text) as { error?: { message?: unknown } };

        if (typeof body.error?.message === "string" && body.error.message.length > 0) {
            return capErrorBody(body.error.message);
        }
    } catch {
        // Not JSON: fall through to the raw text.
    }

    return capErrorBody(text.trim());
};

/** Hint appended to the refusals a user can act on. */
const hintForStatus = (status: number): string => {
    switch (status) {
        case 401:
        case 403: {
            return " — check that the token matches the one the app passes to createNodeProfileHandler";
        }
        case 404: {
            return " — check the URL: it must be the route the app mounted createNodeProfileHandler on";
        }
        case 409: {
            return " — a capture is already running in that app process; wait for it to finish";
        }
        default: {
            return "";
        }
    }
};

/**
 * Write beside the target and rename into place, so a failed write never
 * truncates a capture already at `file`. Returns the failure reason, or
 * `undefined` on success.
 */
const writeAtomically = (file: string, bytes: Uint8Array): string | undefined => {
    const temporary = `${file}.${String(process.pid)}.tmp`;

    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(temporary, bytes);
        renameSync(temporary, file);

        return undefined;
    } catch (error) {
        // Best effort: when the parent is not a directory the temporary file cannot exist, and removing it fails too.
        try {
            rmSync(temporary, { force: true });
        } catch {
            // Nothing to clean up.
        }

        return error instanceof Error ? error.message : String(error);
    }
};

/** The refusal for a project this command cannot profile, or `undefined` for a Node project. */
const refuseNonNodeTarget = (options: ProfileCommandOptions): ProfileResult | undefined => {
    const { logger } = options;
    const resolved = resolveTargetOrError(options.cwd, options.target);

    if (resolved.error !== undefined) {
        return fail(logger, EXIT_CODE.USAGE, `profile: ${resolved.error}`);
    }

    if (resolved.target === "cloudflare") {
        return fail(
            logger,
            EXIT_CODE.USAGE,
            "profile: this project deploys to Cloudflare. `lunora profile` profiles a Node-target app; on Cloudflare run `lunora cloudflare profile`.",
        );
    }

    if (resolved.target !== NODE_TARGET) {
        return fail(logger, EXIT_CODE.USAGE, `profile: only the node target is supported here — pass --target ${NODE_TARGET}`);
    }

    return undefined;
};

/** The URL and bearer the request is sent with, or the refusal that stops it. */
const resolveEndpoint = (options: ProfileCommandOptions): ProfileResult | { token: string; url: string } => {
    const { logger } = options;

    if (options.url === undefined || options.url === "") {
        return fail(
            logger,
            EXIT_CODE.USAGE,
            "profile: pass --url with the full URL of the route the app mounts createNodeProfileHandler on (there is no default for a Node app)",
        );
    }

    const url = resolveAdminBaseUrl(options.url, logger, options.cwd);

    if (url === undefined) {
        // `resolveAdminBaseUrl` already logged why it refused the URL.
        return { code: EXIT_CODE.USAGE, error: "could not resolve a usable profile URL" };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd, token: options.token, url });

    if (token === undefined) {
        return fail(logger, EXIT_CODE.AUTH, "profile: no admin token — pass --token, or set LUNORA_ADMIN_TOKEN");
    }

    return { token, url };
};

const runProfileCommand = async (options: ProfileCommandOptions): Promise<ProfileResult> => {
    const { logger } = options;
    const checked = validate(options);

    if ("error" in checked) {
        return fail(logger, EXIT_CODE.USAGE, checked.error);
    }

    const refusal = refuseNonNodeTarget(options);

    if (refusal !== undefined) {
        return refusal;
    }

    const endpoint = resolveEndpoint(options);

    if ("code" in endpoint) {
        return endpoint;
    }

    const { token, url: baseUrl } = endpoint;
    const { durationMs, profileType } = checked;
    const body = { duration_ms: durationMs, profile_type: profileType };
    const fetchImpl = options.fetchImpl ?? adminFetch;

    logger.info(`Profiling ${baseUrl} (${profileType}) for ${String(durationMs)} ms — keep traffic flowing to it…`);

    let response: Response;

    try {
        response = await fetchImpl(baseUrl, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(durationMs + RESPONSE_MARGIN_MS),
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return fail(logger, EXIT_CODE.UNAVAILABLE, `profile failed: ${reason}.`);
    }

    if (!response.ok) {
        const reason = describeBody(await response.text());

        return fail(
            logger,
            exitCodeForStatus(response.status),
            `profile failed (HTTP ${String(response.status)})${reason.length > 0 ? `: ${reason}` : ""}${hintForStatus(response.status)}.`,
        );
    }

    // Binary gzip — never `.text()` / JSON-parse a success body.
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
        const reason = describeBody(new TextDecoder().decode(bytes));

        return fail(
            logger,
            EXIT_CODE.FAILURE,
            `profile failed: the app answered 200 with something that is not a gzip profile${reason.length > 0 ? `: ${reason}` : ""}.`,
        );
    }

    const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-");
    const file = resolve(options.cwd, options.out ?? `profile-${profileType}-${stamp}.pprof.gz`);

    const writeError = writeAtomically(file, bytes);

    if (writeError !== undefined) {
        return fail(logger, EXIT_CODE.FAILURE, `profile failed: could not write ${file}: ${writeError}.`);
    }

    logger.success(`Wrote ${String(bytes.byteLength)} bytes to ${file}`);
    logger.info("Open it with `go tool pprof -http=: <file>` (pprof reads gzip directly) or upload it to a flamegraph viewer.");

    return { code: EXIT_CODE.SUCCESS, data: { bytes: bytes.byteLength, durationMs, file, profileType, url: baseUrl } };
};

/** `lunora profile` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<ProfileOptions> = defineHandler<ProfileOptions, ProfileData>(async ({ cwd, logger, options }) => {
    const result = await runProfileCommand({
        cwd,
        durationMs: options.durationMs,
        logger,
        out: options.out,
        profileType: options.type,
        target: options.target,
        token: options.token,
        url: options.url,
    });

    return { code: result.code, data: result.data, error: result.error };
});

export type { ProfileCommandOptions, ProfileData, ProfileResult };
export { execute, runProfileCommand };
