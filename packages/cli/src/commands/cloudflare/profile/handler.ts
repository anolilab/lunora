/**
 * `lunora cloudflare profile` — capture an on-demand CPU or heap profile from a
 * live Worker (or one of its Durable Objects) and save it as a gzip-compressed
 * pprof file.
 *
 * Calls `POST /accounts/{id}/workers/workers/{worker}/versions/{version}/profile`.
 * The response is binary (gzipped pprof), so it is read with `arrayBuffer()` and
 * written to disk untouched — the shared REST helper parses every body as JSON
 * and would turn a profile into a failure. The capture does not invoke any
 * code: the target must be taking traffic while it runs.
 *
 * Credentials follow the other API-backed tools: `CLOUDFLARE_API_TOKEN` (needs
 * "Workers Scripts Read") and `CLOUDFLARE_ACCOUNT_ID`, falling back to the
 * wrangler config's `account_id`.
 * @see https://developers.cloudflare.com/workers/observability/profiling-in-production/
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { capErrorBody } from "../../../../../../shared/cap-error-body";
import type { CloudflareEnvironment } from "../../../util/cloudflare-credentials";
import { resolveCloudflareCredentials } from "../../../util/cloudflare-credentials";
import { EXIT_CODE, exitCodeForStatus } from "../../../util/exit-code";
import type { Logger } from "../../../util/logger";

/** The subset of the wrangler config this command reads. */
interface WranglerProfileShape {
    account_id?: unknown;
    name?: unknown;
    upload_source_maps?: unknown;
}

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

const PERMISSION = "Workers Scripts Read";

/** `duration_ms` bounds the API accepts. */
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 50_000;
const DEFAULT_DURATION_MS = 10_000;

/** Slack on top of the capture window for the API to serialise and return the profile. */
const RESPONSE_MARGIN_MS = 30_000;

/** The first two bytes of every gzip stream, which is what the API returns on success. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

const PROFILE_TYPES = ["cpu", "heap"] as const;

type ProfileType = (typeof PROFILE_TYPES)[number];

/** A Durable Object instance id: 64 hexadecimal characters. */
const ACTOR_ID_RE = /^[\da-f]{64}$/iu;

interface ProfileCommandOptions {
    /** Durable Object instance id (64 hex); requires `namespaceId`. */
    actorId?: string;
    cwd: string;
    /** Capture window in ms (default 10000, 1000–50000). */
    durationMs?: string;
    /** Wrangler environment: deployed as `<name>-<env>`. */
    env?: string;
    /** Defaults to `process.env`. */
    environment?: CloudflareEnvironment;
    /** Defaults to the global `fetch`; injected in tests. */
    fetch?: typeof globalThis.fetch;
    logger: Logger;
    /** Durable Object namespace id; requires `actorId`. */
    namespaceId?: string;
    /** Clock for the default file name (tests). */
    now?: Date;
    /** Output file; defaults to `<worker>-<type>-<timestamp>.pprof.gz` in `cwd`. */
    out?: string;
    type?: string;
    /** Worker version id, or `latest` (default). */
    version?: string;
    /** Worker name or id; defaults to the wrangler config's `name`. */
    worker?: string;
}

interface ProfileData {
    bytes: number;
    durationMs: number;
    file: string;
    profileType: ProfileType;
    version: string;
    worker: string;
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

/** The `errors[].message` strings of a v4 envelope, or the capped raw text when the body is not one. */
const describeBody = (text: string): string => {
    try {
        const body = JSON.parse(text) as { errors?: unknown };

        if (Array.isArray(body.errors)) {
            const messages = body.errors
                .map((entry: unknown) => (typeof entry === "object" && entry !== null && "message" in entry ? String(entry.message) : ""))
                .filter((message) => message.length > 0);

            if (messages.length > 0) {
                return capErrorBody(messages.join("; "));
            }
        }
    } catch {
        // Not JSON — a gateway page; fall through to the raw text.
    }

    return capErrorBody(text.trim());
};

/** Hint appended to the refusals a user can act on. */
const hintForStatus = (status: number): string => {
    switch (status) {
        case 401:
        case 403: {
            return ` — check that CLOUDFLARE_API_TOKEN is valid and has the "${PERMISSION}" permission on this account`;
        }
        case 404: {
            return " — check the worker name, version, and (for a Durable Object) the namespace and actor ids";
        }
        case 429: {
            return " — rate limited; wait and retry";
        }
        default: {
            return "";
        }
    }
};

const validate = (options: ProfileCommandOptions): { error: string } | { durationMs: number; profileType: ProfileType } => {
    const profileType = (options.type ?? "cpu") as ProfileType;

    if (!PROFILE_TYPES.includes(profileType)) {
        return { error: `profile: invalid --type "${options.type ?? ""}" — expected ${PROFILE_TYPES.join(" | ")}` };
    }

    const durationMs = options.durationMs === undefined ? DEFAULT_DURATION_MS : Number(options.durationMs);

    if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
        return {
            error: `profile: invalid --duration-ms "${options.durationMs ?? ""}" — expected an integer from ${String(MIN_DURATION_MS)} to ${String(MAX_DURATION_MS)}`,
        };
    }

    if ((options.namespaceId === undefined) !== (options.actorId === undefined)) {
        return { error: "profile: --namespace-id and --actor-id must be passed together to profile a Durable Object" };
    }

    if (options.actorId !== undefined && !ACTOR_ID_RE.test(options.actorId)) {
        return { error: "profile: --actor-id must be a 64-character hexadecimal Durable Object id" };
    }

    return { durationMs, profileType };
};

interface Target {
    accountId: string;
    sourceMapsMissing: boolean;
    token: string;
    worker: string;
}

/** The account, token and Worker to profile, or the refusal that stops the command before any call. */
const resolveTarget = (options: ProfileCommandOptions): ProfileResult | Target => {
    const { logger } = options;
    const wranglerPath = findWranglerFile(options.cwd);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerProfileShape>(wranglerPath).parsed;
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, wrangler?.account_id);

    if (token === undefined) {
        return fail(
            logger,
            EXIT_CODE.AUTH,
            `CLOUDFLARE_API_TOKEN is not set. \`lunora cloudflare profile\` calls the Cloudflare API with an API token (a wrangler login session is not reused); create one with the "${PERMISSION}" permission.`,
        );
    }

    if (accountId === undefined) {
        return fail(logger, EXIT_CODE.USAGE, "No Cloudflare account: set CLOUDFLARE_ACCOUNT_ID or `account_id` in wrangler.jsonc.");
    }

    const configuredName = typeof wrangler?.name === "string" && wrangler.name.length > 0 ? wrangler.name : undefined;
    const baseName = options.worker ?? configuredName;

    if (baseName === undefined) {
        return fail(logger, EXIT_CODE.USAGE, "profile: no Worker name — pass one, or set `name` in wrangler.jsonc.");
    }

    // A wrangler environment deploys as `<name>-<env>`; an explicit worker name is taken as given.
    const worker = options.worker === undefined && options.env !== undefined ? `${baseName}-${options.env}` : baseName;

    return { accountId, sourceMapsMissing: wrangler !== undefined && wrangler.upload_source_maps !== true, token, worker };
};

/**
 * Write beside the target and rename into place, so a failed write never
 * truncates a capture already at `file`. Returns the failure reason, or
 * `undefined` on success.
 */
const writeAtomically = (file: string, bytes: Uint8Array): string | undefined => {
    const temporary = `${file}.${String(process.pid)}.tmp`;

    try {
        writeFileSync(temporary, bytes);
        renameSync(temporary, file);

        return undefined;
    } catch (error) {
        rmSync(temporary, { force: true });

        return error instanceof Error ? error.message : String(error);
    }
};

const runProfileCommand = async (options: ProfileCommandOptions): Promise<ProfileResult> => {
    const { logger } = options;
    const checked = validate(options);

    if ("error" in checked) {
        return fail(logger, EXIT_CODE.USAGE, checked.error);
    }

    const target = resolveTarget(options);

    if ("code" in target) {
        return target;
    }

    const { durationMs, profileType } = checked;
    const { accountId, token, worker } = target;
    const version = options.version ?? "latest";
    const body = {
        duration_ms: durationMs,
        profile_type: profileType,
        ...(options.namespaceId === undefined || options.actorId === undefined ? {} : { actor_id: options.actorId, namespace_id: options.namespaceId }),
    };
    const url = `${API_BASE}/${encodeURIComponent(accountId)}/workers/workers/${encodeURIComponent(worker)}/versions/${encodeURIComponent(version)}/profile`;
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

    logger.info(`Profiling ${worker}@${version} (${profileType}) for ${String(durationMs)} ms — keep traffic flowing to it…`);

    let response: Response;

    try {
        response = await fetchImpl(url, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(durationMs + RESPONSE_MARGIN_MS),
        });
    } catch (error) {
        return fail(logger, EXIT_CODE.UNAVAILABLE, `profile failed: ${error instanceof Error ? error.message : String(error)}.`);
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

    // A 200 can still carry a `{ success: false }` JSON envelope; only a gzip stream is a profile.
    if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
        const reason = describeBody(new TextDecoder().decode(bytes));

        return fail(
            logger,
            EXIT_CODE.FAILURE,
            `profile failed: the API answered 200 with something that is not a gzip profile${reason.length > 0 ? `: ${reason}` : ""}.`,
        );
    }

    const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-");
    const file = resolve(options.cwd, options.out ?? `${worker}-${profileType}-${stamp}.pprof.gz`);

    mkdirSync(dirname(file), { recursive: true });

    const writeError = writeAtomically(file, bytes);

    if (writeError !== undefined) {
        return fail(logger, EXIT_CODE.FAILURE, `profile failed: could not write ${file}: ${writeError}.`);
    }

    logger.success(`Wrote ${String(bytes.byteLength)} bytes to ${file}`);
    logger.info("Open it with `go tool pprof -http=: <file>` (pprof reads gzip directly) or upload it to a flamegraph viewer.");

    if (target.sourceMapsMissing) {
        logger.warn("wrangler config has no `upload_source_maps: true` — TypeScript function names in the profile may be mangled.");
    }

    return { code: EXIT_CODE.SUCCESS, data: { bytes: bytes.byteLength, durationMs, file, profileType, version, worker } };
};

export type { ProfileCommandOptions, ProfileData, ProfileResult };
export { runProfileCommand };
