/**
 * `lunora profile` — ask a Node-target app for an on-demand CPU or heap profile
 * and save it as a gzip-compressed pprof file.
 *
 * The app serves the capture from the route it mounted `createNodeProfileHandler`
 * on, so `--url` is that full route, not a host. Validation, the request, the
 * status and body mapping, and the atomic write are shared with the other profile
 * commands (see `util/pprof-capture`). What is left here is Node-specific: the
 * target check, the URL and bearer, and the `{ error: { message } }` body shape.
 *
 * Only the Node target has an app-side handler. On Cloudflare the same thing is
 * `lunora cloudflare profile`, which this command points to instead of
 * duplicating it.
 */
import { capErrorBody } from "../../../../../shared/cap-error-body";
import { resolveAdminBearer } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { ProfileType } from "../../util/pprof-capture";
import { captureProfile, validateProfileRequest, writeProfile } from "../../util/pprof-capture";
import type { ProfileOptions } from "./index";

interface ProfileCommandOptions {
    cwd: string;
    /** Capture window in ms, as typed (default 10000). */
    durationMs?: string;
    /** Defaults to the admin fetch; injected in tests. */
    fetchImpl?: typeof adminFetch;
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

    if (resolved.target !== "node") {
        return fail(logger, EXIT_CODE.USAGE, "profile: only the node target is supported here — pass --target node");
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
    const request = validateProfileRequest(options.profileType, options.durationMs);

    if ("error" in request) {
        return fail(logger, EXIT_CODE.USAGE, request.error);
    }

    const refusal = refuseNonNodeTarget(options);

    if (refusal !== undefined) {
        return refusal;
    }

    const endpoint = resolveEndpoint(options);

    if ("code" in endpoint) {
        return endpoint;
    }

    const { durationMs, profileType } = request;
    const captured = await captureProfile({
        body: { duration_ms: durationMs, profile_type: profileType },
        describeBody,
        durationMs,
        fetch: options.fetchImpl ?? adminFetch,
        headers: { Authorization: `Bearer ${endpoint.token}` },
        hintForStatus,
        logger,
        url: endpoint.url,
    });

    if ("code" in captured) {
        return fail(logger, captured.code, captured.error);
    }

    const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-");
    const written = writeProfile(options.cwd, options.out, `profile-${profileType}-${stamp}.pprof.gz`, captured.bytes);

    if ("error" in written) {
        return fail(logger, EXIT_CODE.FAILURE, `profile failed: ${written.error}.`);
    }

    logger.success(`Wrote ${String(captured.bytes.byteLength)} bytes to ${written.file}`);
    logger.info("Open it with `go tool pprof -http=: <file>` (pprof reads gzip directly) or upload it to a flamegraph viewer.");

    return {
        code: EXIT_CODE.SUCCESS,
        data: { bytes: captured.bytes.byteLength, durationMs, file: written.file, profileType, url: endpoint.url },
    };
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
