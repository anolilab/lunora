/**
 * `BoxSessionDO` — one per box, named by its id (plan 458 D1, G11): the end of
 * the WebSocket `lunora-hostd` dials out to, and the only way the control
 * plane reaches the box. The first Durable Object of `apps/cloud`'s own.
 *
 * - **Session.** Hibernatable WebSockets (`acceptWebSocket`); the handshake
 *   and every frame are handled by the pure `receiveFrame` (`./session`), with
 *   the per-socket state in the socket's attachment so it survives hibernation.
 * - **Liveness.** An alarm every {@link TICK_MS} pings authenticated boxes,
 *   closes a box silent for 90 s (it goes `offline`), closes handshakes that
 *   stall, and re-reads the row so a revoke made anywhere cuts the box off.
 * - **Internal API.** `fetch` serves the control plane's own calls over the
 *   namespace binding — `/dispatch` (run a job and stream its progress),
 *   `/routes` (push the box's routing table), `/close` (revoke), `/nonce`
 *   (replay protection for box-signed requests). The public router forwards
 *   ONLY the upgrade (`GET /v1/boxes/connect` → `/connect`), so none of these
 *   is reachable from outside. `./session-client` is their typed caller.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import type { CloudMessage, HostdJob, ReportMessage } from "@lunora/hostd/protocol";
import { encodeMessage, HOSTD_PROTOCOL_LIMITS } from "@lunora/hostd/protocol";

import type { ControlPlaneStore } from "../d1-store";
import { controlPlaneDatabase } from "../d1-store";
import stripTrailingSlashes from "../lib/strip-trailing-slashes";
import type { ReleaseVersions } from "./hostd-releases";
import { versionKey } from "./hostd-releases";
import { JobRegistry, MAX_JOBS_IN_FLIGHT } from "./jobs";
import type { SessionAttachment, SessionEffect } from "./session";
import { livenessOf, openSession, receiveFrame } from "./session";
import { loadBox, markOffline, markSeen, recordHello, routesForBox, SEEN_WRITE_INTERVAL_MS, sessionBoxOf } from "./session-store";
import { recordBoxReport } from "./usage";

/** The env slice the session reads. A `type` so the control plane's env types stay assignable to it. */
export type BoxSessionEnvironment = {
    /** The control-plane D1 the session records liveness in; absent → every box is refused. */
    DB?: unknown;
    /** The apex boxes' default hostnames live under (`{alias}.{slug}.{LUNORA_BOX_DOMAIN}`). */
    LUNORA_BOX_DOMAIN?: string;
    /** This control plane's public origin — where a box fetches the release manifest an `upgrade` job names. */
    LUNORA_ORIGIN_URL?: string;
};

/** The hibernatable-WebSocket slice of a socket the session uses. */
export interface SessionSocket {
    close: (code?: number, reason?: string) => void;
    deserializeAttachment: () => unknown;
    send: (message: string) => void;
    serializeAttachment: (value: unknown) => void;
}

/** The slice of `DurableObjectState` the session uses — structural, so the unit tests can drive it. */
export interface SessionState {
    acceptWebSocket: (socket: SessionSocket) => void;
    getWebSockets: () => SessionSocket[];
    storage: {
        delete: (key: string) => Promise<unknown>;
        get: <T>(key: string) => Promise<T | undefined>;
        getAlarm: () => Promise<null | number>;
        list: <T>(options: { limit?: number; prefix: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
        setAlarm: (time: number) => Promise<void>;
    };
}

/** The liveness tick: ping cadence, and how often stalled handshakes and silent boxes are found. */
export const TICK_MS = 30_000;

/** Sockets one box may hold open at once — a reconnect overlaps its old socket briefly, nothing more. */
export const MAX_SOCKETS = 4;

/** Bounds on a dispatched job's wait. */
const MIN_JOB_TIMEOUT_MS = 1000;

const MAX_JOB_TIMEOUT_MS = 15 * 60 * 1000;

const BOX_ID_PATTERN = /^[\w-]{1,128}$/u;

const NONCE_PATTERN = /^[\w-]{22,128}$/u;

/** A `report` window must start on a whole minute (README §5.1). */
const REPORT_ALIGNMENT_MS = 60_000;

/** Close code for every refusal: 1008, policy violation. */
const POLICY_VIOLATION = 1008;

const NONCE_PREFIX = "nonce:";

const json = (status: number, body: unknown): Response => Response.json(body, { status });

const ERROR_CODE_PATTERN = /^[A-Z][A-Z\d_]{0,63}$/u;

const attachmentOf = (socket: SessionSocket): SessionAttachment => socket.deserializeAttachment() as SessionAttachment;

/** Send one frame. A socket that is already gone is not an error here — its close handler cleans up. */
const sendFrame = (socket: SessionSocket, message: CloudMessage): void => {
    try {
        socket.send(encodeMessage(message));
    } catch {
        // The socket closed under us.
    }
};

/** Truncate to the protocol's error-message cap, by bytes. */
const capMessage = (message: string): string => {
    const bytes = new TextEncoder().encode(message);

    return bytes.length <= HOSTD_PROTOCOL_LIMITS.maxErrorMessageBytes
        ? message
        : new TextDecoder().decode(bytes.slice(0, HOSTD_PROTOCOL_LIMITS.maxErrorMessageBytes - 3));
};

/** Refuse a socket: one `error` frame, then close (README §2.6). */
const refuseSocket = (socket: SessionSocket, code: string, message: string): void => {
    const attachment = attachmentOf(socket);

    sendFrame(socket, { code, message: capMessage(message), type: "error" });

    try {
        socket.close(POLICY_VIOLATION, code);
    } catch {
        // Already closed.
    }

    // Marked so liveness and `readySockets` stop counting it before the runtime drops it.
    socket.serializeAttachment({ ...attachment, closed: true } satisfies SessionAttachment);
};

export class BoxSessionDO {
    private readonly jobs = new JobRegistry();

    /** Reports are recorded one at a time, so a replay racing its original is still seen as a replay. */
    private reports: Promise<unknown> = Promise.resolve();

    private readonly state: SessionState;

    private readonly environment: BoxSessionEnvironment;

    public constructor(state: SessionState, environment: BoxSessionEnvironment) {
        this.state = state;
        this.environment = environment;
    }

    /** The control plane's internal calls, and the box's upgrade. */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const boxId = url.searchParams.get("box") ?? "";

        if (!BOX_ID_PATTERN.test(boxId)) {
            return json(400, { code: "BAD_REQUEST", message: "box must be a box id" });
        }

        await this.state.storage.put("boxId", boxId);

        switch (url.pathname) {
            case "/close": {
                return this.closeAll(request);
            }
            case "/connect": {
                return await this.connect(request, boxId);
            }
            case "/dispatch": {
                return this.dispatch(request);
            }
            case "/nonce": {
                return this.claimNonce(request);
            }
            case "/routes": {
                return json(200, { pushed: await this.pushRoutes(boxId) });
            }
            default: {
                return json(404, { code: "NOT_FOUND", message: "not found" });
            }
        }
    }

    /** One frame from a box. */
    public async webSocketMessage(socket: SessionSocket, message: ArrayBuffer | string): Promise<void> {
        const attachment = attachmentOf(socket);
        const database = this.database();

        // A refused socket's last frames, in flight before the close lands, count for nothing.
        if (attachment.closed === true) {
            return;
        }

        if (database === undefined) {
            refuseSocket(socket, "UNAVAILABLE", "this control plane cannot accept boxes right now");

            return;
        }

        const now = Date.now();
        const { attachment: next, effects } = await receiveFrame(attachment, message, now, {
            loadBox: async (boxId) => sessionBoxOf(await loadBox(database, boxId)),
        });

        socket.serializeAttachment(next);

        for (const effect of effects) {
            // eslint-disable-next-line no-await-in-loop -- effects are ordered: a challenge before anything that follows it
            await this.apply(socket, next, effect, database, now);
        }
    }

    /** The box's socket closed. */
    public async webSocketClose(socket: SessionSocket, code: number, reason: string): Promise<void> {
        try {
            socket.close(code, reason);
        } catch {
            // Already closed — the runtime may have completed the close handshake itself.
        }

        await this.socketGone(socket);
    }

    /** The box's socket failed. */
    public async webSocketError(socket: SessionSocket): Promise<void> {
        await this.socketGone(socket);
    }

    /** The liveness tick. */
    public async alarm(): Promise<void> {
        const sockets = this.state.getWebSockets();
        const boxId = await this.state.storage.get<string>("boxId");
        const database = this.database();
        const now = Date.now();

        // A revoke made anywhere — the studio route, or the bare mutation over RPC —
        // reaches the box here within one tick.
        const box = database === undefined || boxId === undefined ? null : await loadBox(database, boxId);

        if (box?.status === "revoked") {
            for (const socket of sockets) {
                refuseSocket(socket, "BOX_REVOKED", "this box has been revoked; enrol the machine again to use it");
            }
        } else {
            for (const socket of sockets.filter((candidate) => attachmentOf(candidate).closed !== true)) {
                switch (livenessOf(attachmentOf(socket), now)) {
                    case "close-handshake": {
                        refuseSocket(socket, "AUTH_FAILED", "the handshake did not complete in time");
                        break;
                    }
                    case "close-silent": {
                        refuseSocket(socket, "TIMEOUT", "no frame from this box for 90 seconds");
                        break;
                    }
                    case "ping": {
                        sendFrame(socket, { type: "ping" });
                        break;
                    }
                    default: {
                        // Still in its handshake, within the timeout.
                        break;
                    }
                }
            }
        }

        await this.sweepNonces(now);

        if (this.readySockets().length === 0 && boxId !== undefined && database !== undefined) {
            this.jobs.failAll("BOX_OFFLINE", "the box's session ended");
            await markOffline(database, boxId);
        }

        if (this.state.getWebSockets().length > 0) {
            await this.state.storage.setAlarm(now + TICK_MS);
        }
    }

    /** The control-plane store, or `undefined` without a `DB` binding. Protected so the unit tests can hand in a fake. */
    protected database(): ControlPlaneStore | undefined {
        return this.environment.DB === undefined ? undefined : controlPlaneDatabase(this.environment.DB as D1DatabaseLike);
    }

    /** Sockets of an authenticated box that the control plane has not refused. */
    private readySockets(): SessionSocket[] {
        return this.state.getWebSockets().filter((socket) => {
            const attachment = attachmentOf(socket);

            return attachment.phase === "ready" && attachment.closed !== true;
        });
    }

    private async connect(request: Request, boxId: string): Promise<Response> {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return json(426, { code: "UPGRADE_REQUIRED", message: "expected a WebSocket upgrade" });
        }

        const sockets = this.state.getWebSockets();

        // Unauthenticated callers can open sockets for any box id. When the cap is
        // reached, make room by dropping the oldest socket still in its handshake —
        // never an authenticated one — so a squatter cannot lock the real box out.
        if (sockets.length >= MAX_SOCKETS) {
            const oldest = sockets
                .filter((socket) => attachmentOf(socket).phase !== "ready")
                .toSorted((a, b) => attachmentOf(a).openedAt - attachmentOf(b).openedAt)
                .at(0);

            if (oldest === undefined) {
                return json(429, { code: "TOO_MANY_SESSIONS", message: "this box already has its sessions open" });
            }

            refuseSocket(oldest, "AUTH_FAILED", "superseded by a newer connection before completing the handshake");
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

        this.state.acceptWebSocket(server);
        server.serializeAttachment(openSession(boxId, Date.now()));
        // Armed for the handshake timeout; the tick re-arms itself while any socket is open.
        if ((await this.state.storage.getAlarm()) === null) {
            await this.state.storage.setAlarm(Date.now() + TICK_MS);
        }

        return new Response(null, { status: 101, webSocket: client });
    }

    private async apply(socket: SessionSocket, attachment: SessionAttachment, effect: SessionEffect, database: ControlPlaneStore, now: number): Promise<void> {
        if ("close" in effect) {
            refuseSocket(socket, effect.code, effect.message);

            return;
        }

        switch (effect.kind) {
            case "authenticated": {
                // One live session per box: a reconnect supersedes the socket it replaces.
                for (const other of this.readySockets()) {
                    if (other !== socket) {
                        refuseSocket(other, "SUPERSEDED", "a newer session for this box authenticated");
                    }
                }

                await recordHello(database, attachment.boxId, effect.hello, now);
                await this.state.storage.put("seenWrittenAt", now);
                await this.pushRoutes(attachment.boxId);
                await this.replayDesiredRelease(database, socket, attachment.boxId, effect.hello.versions);
                break;
            }
            case "pong": {
                const writtenAt = (await this.state.storage.get<number>("seenWrittenAt")) ?? 0;

                if (now - writtenAt >= SEEN_WRITE_INTERVAL_MS) {
                    await markSeen(database, attachment.boxId, now);
                    await this.state.storage.put("seenWrittenAt", now);
                }

                break;
            }
            case "progress": {
                this.jobs.progress(effect.message);
                break;
            }
            case "report": {
                await this.recordReport(database, attachment.boxId, effect.message, now);
                break;
            }
            case "result": {
                this.jobs.result(effect.message);
                break;
            }
            case "send": {
                sendFrame(socket, effect.message);
                break;
            }
            default: {
                break;
            }
        }
    }

    private async socketGone(socket: SessionSocket): Promise<void> {
        const attachment = attachmentOf(socket);
        const database = this.database();

        if (attachment.phase === "ready" && this.readySockets().every((other) => other === socket) && database !== undefined) {
            // The box's authenticated session is gone and no other replaced it.
            this.jobs.failAll("BOX_OFFLINE", "the box's session ended");
            await markOffline(database, attachment.boxId);
        }
    }

    /** `POST /dispatch` — run one job on the box and stream its progress, then its result, as NDJSON. */
    private async dispatch(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => null)) as null | { job?: HostdJob; timeoutMs?: number };
        const socket = this.readySockets().at(0);

        if (socket === undefined) {
            // Fail fast (plan 458 D14): a job is never queued for a box that is not there.
            return json(409, { code: "BOX_OFFLINE", message: "the box is not connected" });
        }

        if (this.jobs.size >= MAX_JOBS_IN_FLIGHT) {
            return json(429, { code: "BOX_BUSY", message: `the box already runs ${String(MAX_JOBS_IN_FLIGHT)} jobs` });
        }

        const jobId = crypto.randomUUID();
        let frame: string;

        try {
            frame = encodeMessage({ job: body?.job as HostdJob, jobId, type: "job" });
        } catch (error) {
            return json(400, { code: "BAD_JOB", message: error instanceof Error ? error.message : "invalid job" });
        }

        const timeoutMs = Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, body?.timeoutMs ?? MAX_JOB_TIMEOUT_MS));
        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        const write = (line: unknown): void => {
            // A caller that stopped reading is not the box's problem; its job still settles.
            writer.write(encoder.encode(`${JSON.stringify(line)}\n`)).catch(() => undefined);
        };

        const outcome = this.jobs.start(jobId, {
            onProgress: (line) => {
                write({ line, type: "progress" });
            },
            timeoutMs,
        });

        socket.send(frame);

        // Settled by the box's `result`, a timeout, or the socket going away — never left hanging.
        const finish = async (): Promise<void> => {
            write({ ...(await outcome), type: "result" });
            await writer.close();
        };

        finish().catch(() => undefined);

        return new Response(readable, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    }

    /**
     * Hand a box that just authenticated the `upgrade` it missed (plan 458 W2):
     * when its row names a desired release whose versions it does not run yet.
     * Fire-and-forget — the job settles on the box's `result` like any other,
     * and the next `hello` shows whether it took.
     */
    private async replayDesiredRelease(database: ControlPlaneStore, socket: SessionSocket, boxId: string, running: ReleaseVersions): Promise<void> {
        const box = await loadBox(database, boxId);
        const origin = this.environment.LUNORA_ORIGIN_URL;

        if (box?.desiredReleaseId == null || origin === undefined) {
            return;
        }

        const { page } = await database.findMany("hostdReleases", { where: { releaseId: box.desiredReleaseId } });
        const release = page[0] as undefined | { releaseId: string; versions: ReleaseVersions };

        if (release === undefined || versionKey(release.versions) === versionKey(running)) {
            return;
        }

        const jobId = crypto.randomUUID();

        // Never rejects (the registry resolves every job); nothing waits on it.
        this.jobs.start(jobId, { onProgress: () => undefined, timeoutMs: MAX_JOB_TIMEOUT_MS }).catch(() => undefined);
        sendFrame(socket, {
            job: {
                kind: "upgrade",
                manifestUrl: `${stripTrailingSlashes(origin)}/v1/hostd/releases/${encodeURIComponent(release.releaseId)}/manifest`,
                releaseId: release.releaseId,
            },
            jobId,
            type: "job",
        });
    }

    /**
     * Record a `report` (plan 458 G15). Only minute-aligned windows are taken: a
     * box reports once a minute, and the alignment is what bounds how many
     * distinct windows — and so how many rows — even a hostile box can produce.
     */
    private async recordReport(database: ControlPlaneStore, boxId: string, report: ReportMessage, now: number): Promise<void> {
        if (report.windowStart % REPORT_ALIGNMENT_MS !== 0) {
            return;
        }

        this.reports = this.reports.then(async () => {
            const box = await loadBox(database, boxId);

            return box === null || box.status === "revoked" ? undefined : recordBoxReport(database, box, report, now);
        });

        await this.reports.catch(() => undefined);
    }

    /** Push the box's full routing table. `false` when the box is not connected; it gets the table when it authenticates. */
    private async pushRoutes(boxId: string): Promise<boolean> {
        const database = this.database();
        const sockets = this.readySockets();

        if (database === undefined || sockets.length === 0) {
            return false;
        }

        const box = await loadBox(database, boxId);

        if (box === null) {
            return false;
        }

        const table = await routesForBox(database, box, this.environment.LUNORA_BOX_DOMAIN ?? "boxes.lunora.app");

        for (const socket of sockets) {
            sendFrame(socket, { table, type: "routes" });
        }

        return true;
    }

    /** `POST /close` — refuse every socket with the given code (revocation). */
    private async closeAll(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => null)) as null | { code?: string; message?: string };
        const code = typeof body?.code === "string" && ERROR_CODE_PATTERN.test(body.code) ? body.code : "BOX_REVOKED";
        const message = typeof body?.message === "string" ? body.message : "this box has been revoked; enrol the machine again to use it";
        const sockets = this.state.getWebSockets();

        for (const socket of sockets) {
            refuseSocket(socket, code, message);
        }

        this.jobs.failAll(code, message);

        return json(200, { closed: sockets.length });
    }

    /**
     * `POST /nonce` — claim a box-chosen request nonce until `expiresAt`. `fresh:
     * false` for a nonce already claimed: the signed request is a replay.
     */
    private async claimNonce(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => null)) as null | { expiresAt?: number; nonce?: string };
        const nonce = body?.nonce;
        const expiresAt = body?.expiresAt;

        if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
            return json(400, { code: "BAD_REQUEST", message: "nonce and expiresAt are required" });
        }

        const now = Date.now();
        const key = `${NONCE_PREFIX}${nonce}`;
        const seen = await this.state.storage.get<number>(key);

        if (seen !== undefined && seen > now) {
            return json(200, { fresh: false });
        }

        await this.state.storage.put(key, expiresAt);
        await this.sweepNonces(now);

        return json(200, { fresh: true });
    }

    /** Forget expired nonces, a bounded batch at a time. */
    private async sweepNonces(now: number): Promise<void> {
        const nonces = await this.state.storage.list<number>({ limit: 256, prefix: NONCE_PREFIX });

        for (const [key, expiresAt] of nonces) {
            if (expiresAt <= now) {
                // eslint-disable-next-line no-await-in-loop -- bounded batch; storage deletes are local
                await this.state.storage.delete(key);
            }
        }
    }
}
