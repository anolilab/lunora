/**
 * Message types of the hostd ↔ control-plane wire protocol (plan 458 W1).
 *
 * Every frame is one UTF-8 JSON object with a string `type`. Box → cloud and
 * cloud → box use disjoint `type` sets, so a frame names its own direction.
 * The normative description, with the caps and the signing payloads, is
 * `protocol/hostd/README.md`.
 */

/** Lifecycle state of one celld fleet on the box, as `hostd` last saw it. */
export type FleetState = "failed" | "running" | "starting" | "stopped";

/** One fleet the box runs, reported in {@link HelloMessage.fleets}. */
export interface FleetSummary {
    /** Deployment alias the fleet serves; one fleet per alias (plan 458 D8). */
    alias: string;
    /** Deployment the fleet currently runs. Absent when nothing has been deployed into it yet. */
    deploymentId?: string;
    state: FleetState;
}

/** Versions of the three binaries on the box. Opaque strings: the cloud displays them, it does not parse them. */
export interface BoxVersions {
    caddy: string;
    celld: string;
    hostd: string;
}

/** Free capacity on the box, in whole mebibytes. */
export interface BoxResources {
    diskFreeMb: number;
    memMb: number;
}

/**
 * Whether the box isolates its fleets (plan 458 W8): `enforced` when every
 * self-check passed; `single-trust` when one failed but the box was enrolled
 * with `--single-trust`, so fleets run anyway; `refused` when one failed and
 * the box therefore starts no fleet.
 */
export type IsolationStatus = "enforced" | "refused" | "single-trust";

/** The box's isolation self-check, reported in {@link HelloMessage.isolation}. */
export interface BoxIsolation {
    /** Each failed check, as a sentence for the studio. Absent when every check passed. */
    problems?: string[];
    status: IsolationStatus;
}

/** First frame on every connection: who the box is, what it speaks, and what it runs. */
export interface HelloMessage {
    boxId: string;
    fleets: FleetSummary[];
    /** The isolation self-check (W8). Absent from a box that has not run one. */
    isolation?: BoxIsolation;
    /** The protocol version the box speaks. See `negotiateProtocolVersion`. */
    protocol: number;
    resources: BoxResources;
    type: "hello";
    versions: BoxVersions;
}

/** Answer to a {@link ChallengeMessage}: an Ed25519 signature over `challengeSigningPayload(nonce, boxId)`, base64url without padding. */
export interface AuthMessage {
    signature: string;
    type: "auth";
}

/** One line of a running job's output. */
export interface ProgressMessage {
    jobId: string;
    line: string;
    type: "progress";
}

/** A machine-readable failure: an upper-snake-case `code` plus a human `message`. */
export interface ProtocolErrorDetail {
    code: string;
    message: string;
}

/**
 * Final outcome of a job. `ok: true` never carries `error`; `ok: false` always
 * does. `url` is the public URL a successful deploy serves on.
 */
export interface ResultMessage {
    error?: ProtocolErrorDetail;
    jobId: string;
    ok: boolean;
    type: "result";
    url?: string;
}

/** Request counts for one alias over a report window. */
export interface AliasReport {
    alias: string;
    /** Requests that ended in an error. Never more than `requests`. */
    errors: number;
    /** Median latency in milliseconds, when the box measured one. */
    p50Ms?: number;
    requests: number;
}

/** Usage over `[windowStart, windowEnd)`, both Unix epoch milliseconds. Studio display only, not billing (plan 458 D12). */
export interface ReportMessage {
    perAlias: AliasReport[];
    type: "report";
    windowEnd: number;
    windowStart: number;
}

/** Answer to a {@link PingMessage}. */
export interface PongMessage {
    type: "pong";
}

/** Every frame a box may send. */
export type BoxMessage = AuthMessage | HelloMessage | PongMessage | ProgressMessage | ReportMessage | ResultMessage;

/** Sent once per connection, after `hello`. The box answers with {@link AuthMessage}. */
export interface ChallengeMessage {
    /** At least 128 bits of randomness, base64url without padding. Single use. */
    nonce: string;
    type: "challenge";
}

/** Fetch a stored release and run it as the fleet for `alias`. */
export interface DeployJob {
    alias: string;
    /** Compatibility date for the fleet, `YYYY-MM-DD`. */
    compatibilityDate?: string;
    /** Cron expressions celld schedules natively (plan 458 D11). Passed through unparsed. */
    crons: string[];
    deploymentId: string;
    kind: "deploy";
    /** Where the box fetches the release with a signed `GET` (plan 458 D6). Releases never travel over the socket. */
    releaseUrl: string;
    /** Vars and secrets, merged (plan 458 D10). */
    vars: Record<string, string>;
}

/** Stop the fleet for `alias` and drop its routes; with `deleteData`, also delete its bucket prefix. */
export interface DestroyJob {
    alias: string;
    deleteData: boolean;
    kind: "destroy";
}

/** Reload the fleet for `alias` in place. */
export interface ReloadJob {
    alias: string;
    kind: "reload";
}

/** Replace the box's own binaries with release `releaseId`, described by the signed manifest at `manifestUrl`. */
export interface UpgradeJob {
    kind: "upgrade";
    manifestUrl: string;
    releaseId: string;
}

/** Collect diagnostics (`celld diagnose --json` and friends) and return them as `progress` lines. */
export interface DiagnoseJob {
    kind: "diagnose";
}

/** Every job the control plane may hand a box, discriminated by `kind`. */
export type HostdJob = DeployJob | DestroyJob | DiagnoseJob | ReloadJob | UpgradeJob;

/** Run one job. The box streams `progress` for `jobId` and ends it with exactly one `result`. */
export interface JobMessage {
    job: HostdJob;
    jobId: string;
    type: "job";
}

/** One row of the routing table: requests for `hostname` go to the fleet for `alias`. */
export interface RouteEntry {
    alias: string;
    hostname: string;
}

/** The full routing table, pushed on every change. It replaces the previous table; it is never a delta. */
export interface RoutesMessage {
    table: RouteEntry[];
    type: "routes";
}

/** Keep-alive. The box answers with {@link PongMessage}. */
export interface PingMessage {
    type: "ping";
}

/** The control plane refuses the box (protocol mismatch, failed auth, revoked) and closes the socket. */
export interface CloudErrorMessage extends ProtocolErrorDetail {
    type: "error";
}

/** Every frame the control plane may send. */
export type CloudMessage = ChallengeMessage | CloudErrorMessage | JobMessage | PingMessage | RoutesMessage;

/** Every frame of the protocol, in either direction. */
export type HostdMessage = BoxMessage | CloudMessage;

/**
 * Why a frame was rejected.
 *
 * - `FRAME_TOO_LARGE`: the encoded frame exceeds the frame cap (256 KiB).
 * - `INVALID_JSON`: the frame is not UTF-8 JSON.
 * - `UNKNOWN_TYPE`: `type` is missing, or not a type this direction sends.
 * - `INVALID_MESSAGE`: the type is known, but a field is missing, unknown, mistyped or over a cap.
 */
export type DecodeErrorCode = "FRAME_TOO_LARGE" | "INVALID_JSON" | "INVALID_MESSAGE" | "UNKNOWN_TYPE";

/** A rejected frame. `path` points at the offending field (`$.job.alias`) when there is one. */
export interface DecodeError {
    code: DecodeErrorCode;
    message: string;
    path?: string;
}

/** Outcome of decoding one frame. Decoding never throws. */
export type DecodeResult<T> = { error: DecodeError; ok: false } | { message: T; ok: true };
