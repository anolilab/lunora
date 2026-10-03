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
 * - **Internal API.** Native RPC over the namespace binding ({@link BoxSession}):
 *   `dispatch` (run a job, its progress called back as it arrives),
 *   `pushRoutes` (push the box's routing table), `close` (revoke) and
 *   `claimNonce` (replay protection for box-signed requests). `fetch` takes
 *   only the box's WebSocket upgrade — the one call the public router forwards
 *   (`GET /v1/boxes/connect`) — so none of the rest is reachable from outside.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import type { BoxVersions, CloudMessage, FleetSummary, HostdJob, ReportMessage } from "@lunora/hostd/protocol";
import { encodeMessage, HOSTD_PROTOCOL_LIMITS, isErrorCode, isNonce, isProtocolId } from "@lunora/hostd/protocol";
import { DurableObject } from "cloudflare:workers";

import type { ControlPlaneStore } from "../d1-store";
import { controlPlaneDatabase } from "../d1-store";
import { fleetsAfterJob, jobMovesFleets } from "./fleets";
import { versionKey } from "./hostd-releases";
import type { JobOutcome } from "./jobs";
import { JobRegistry, MAX_JOBS_IN_FLIGHT } from "./jobs";
import type { SessionAttachment, SessionEffect } from "./session";
import { livenessOf, openSession, receiveFrame, REVOKED_MESSAGE } from "./session";
import type { BoxSession } from "./session-client";
import { loadBox, markOffline, markSeen, recordHello, routesForBox, SEEN_WRITE_INTERVAL_MS, sessionBoxOf, updateFleets } from "./session-store";
import { boxDomainOf, manifestUrlOf } from "./urls";
import { MAX_REPORT_AGE_MS, recordBoxReport } from "./usage";

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

/** The liveness tick: ping cadence, and how often stalled handshakes and silent boxes are found. */
export const TICK_MS = 30_000;

/** Sockets one box may hold open at once — a reconnect overlaps its old socket briefly, nothing more. */
export const MAX_SOCKETS = 4;

/** Bounds on a dispatched job's wait. */
const MIN_JOB_TIMEOUT_MS = 1000;

const MAX_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** A `report` window must start on a whole minute (README §5.1). */
const REPORT_ALIGNMENT_MS = 60_000;

/**
 * Reports one socket may send per minute. A box reports once a minute; the
 * headroom is for its backlog after a reconnect (a day of windows drains in
 * under half an hour), and the cap is what bounds the control-plane reads a
 * hostile box can cause.
 */
export const MAX_REPORTS_PER_MINUTE = 60;

/** Reports queued behind the one being recorded. Beyond it a report is dropped and logged, never chained. */
export const MAX_PENDING_REPORTS = 8;

/** Storage prefix of the report windows this box's session has processed. */
const REPORT_PREFIX = "report:";

/** Close code for every refusal: 1008, policy violation. */
const POLICY_VIOLATION = 1008;

const NONCE_PREFIX = "nonce:";

const json = (status: number, body: unknown): Response => Response.json(body, { status });

/** A job the session refuses before the box sees it. */
const refusedJob = (code: string, message: string): JobOutcome => {
    return { error: { code, message }, ok: false };
};

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

export class BoxSessionDO extends DurableObject<BoxSessionEnvironment> implements BoxSession {
    private readonly jobs = new JobRegistry();

    /** Reports are recorded one at a time, so a replay racing its original is still seen as a replay. Never rejects. */
    private reports: Promise<void> = Promise.resolve();

    /** Reports chained on {@link reports} and not yet recorded. */
    private pendingReports = 0;

    /** Fleet updates from finished jobs, one at a time, so two jobs finishing together cannot lose each other's write. Never rejects. */
    private fleetWrites: Promise<void> = Promise.resolve();

    /**
     * The fleets each challenged `hello` reported, by challenge nonce, until its
     * `auth` arrives — in memory, because a 500-fleet list does not fit a socket
     * attachment. At most {@link MAX_SOCKETS} handshakes run at once; older
     * entries are dropped past that, and an entry lost to an eviction only means
     * the box's stored fleets wait for its next `hello` or job.
     */
    private readonly pendingFleets = new Map<string, FleetSummary[]>();

    /**
     * Each socket's report count in the current minute. In memory rather than in
     * the attachment: a frame's attachment is read before an `await` and written
     * after it, so a counter there is lost to any two frames that interleave.
     */
    private readonly reportBudgets = new WeakMap<SessionSocket, { count: number; minute: number }>();

    /**
     * The box's WebSocket upgrade (`GET /v1/boxes/connect?box={id}`, forwarded
     * as is). Remembers which box this object is, for the liveness tick.
     */
    public override async fetch(request: Request): Promise<Response> {
        const boxId = new URL(request.url).searchParams.get("box") ?? "";

        if (!isProtocolId(boxId)) {
            return json(400, { code: "BAD_REQUEST", message: "box must be a box id" });
        }

        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return json(426, { code: "UPGRADE_REQUIRED", message: "expected a WebSocket upgrade" });
        }

        await this.ctx.storage.put("boxId", boxId);

        return this.acceptSocket(boxId);
    }

    /** One frame from a box. */
    public override async webSocketMessage(socket: SessionSocket, message: ArrayBuffer | string): Promise<void> {
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
    public override async webSocketClose(socket: SessionSocket, code: number, reason: string): Promise<void> {
        try {
            socket.close(code, reason);
        } catch {
            // Already closed — the runtime may have completed the close handshake itself.
        }

        await this.socketGone(socket);
    }

    /** The box's socket failed. */
    public override async webSocketError(socket: SessionSocket): Promise<void> {
        await this.socketGone(socket);
    }

    /** The liveness tick. */
    public override async alarm(): Promise<void> {
        const sockets = this.ctx.getWebSockets();
        const boxId = await this.ctx.storage.get<string>("boxId");
        const database = this.database();
        const now = Date.now();

        // A revoke made anywhere — the studio route or the box sweep — reaches the box
        // here within one tick. So does an erasure: once the row is gone (the org was
        // purged) the box is no longer anyone's, and its session ends the same way.
        const known = database !== undefined && boxId !== undefined;
        const box = known ? await loadBox(database, boxId) : null;

        if (known && (box === null || box.status === "revoked")) {
            for (const socket of sockets.filter((candidate) => attachmentOf(candidate).closed !== true)) {
                refuseSocket(socket, "BOX_REVOKED", REVOKED_MESSAGE);
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
        await this.sweepReportWindows(now);

        if (this.readySockets().length === 0 && boxId !== undefined && database !== undefined) {
            this.jobs.failAll("BOX_OFFLINE", "the box's session ended");
            await markOffline(database, boxId);
        }

        if (this.ctx.getWebSockets().length > 0) {
            await this.ctx.storage.setAlarm(now + TICK_MS);
        }
    }

    /** Run one job on the box; see {@link BoxSession.dispatch}. */
    public async dispatch(job: HostdJob, options: { onProgress?: (line: string) => void; timeoutMs?: number } = {}): Promise<JobOutcome> {
        const socket = this.readySockets().at(0);

        if (socket === undefined) {
            // Fail fast (plan 458 D14): a job is never queued for a box that is not there.
            return refusedJob("BOX_OFFLINE", "the box is not connected");
        }

        if (this.jobs.size >= MAX_JOBS_IN_FLIGHT) {
            return refusedJob("BOX_BUSY", `the box already runs ${String(MAX_JOBS_IN_FLIGHT)} jobs`);
        }

        const jobId = crypto.randomUUID();
        let frame: string;

        try {
            frame = encodeMessage({ job, jobId, type: "job" });
        } catch (error) {
            return refusedJob("BAD_JOB", error instanceof Error ? error.message : "invalid job");
        }

        const { onProgress } = options;
        // Settled by the box's `result`, a timeout, or the socket going away — never left hanging.
        const outcome = this.jobs.start(jobId, {
            onProgress: (line) => {
                // Over RPC this calls back into the caller; one that stopped listening is not the box's problem.
                Promise.resolve(onProgress?.(line)).catch(() => undefined);
            },
            owner: socket,
            timeoutMs: Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, options.timeoutMs ?? MAX_JOB_TIMEOUT_MS)),
        });

        socket.send(frame);

        const settled = await outcome;

        await this.recordFleets(attachmentOf(socket).boxId, job, settled);

        return settled;
    }

    /** Push the box's full routing table. `false` when the box is not connected; it gets the table when it authenticates. */
    public async pushRoutes(): Promise<boolean> {
        const database = this.database();
        const sockets = this.readySockets();
        const boxId = sockets.length === 0 ? undefined : attachmentOf(sockets[0]).boxId;

        if (database === undefined || boxId === undefined) {
            return false;
        }

        const box = await loadBox(database, boxId);

        if (box === null) {
            return false;
        }

        const table = await routesForBox(database, box, boxDomainOf(this.env));

        for (const socket of sockets) {
            sendFrame(socket, { table, type: "routes" });
        }

        return true;
    }

    /** Refuse every socket with `code` (revocation), and fail the jobs sent on them. */
    public close(code: string, message: string): Promise<number> {
        const reason = isErrorCode(code) ? code : "BOX_REVOKED";
        const sockets = this.ctx.getWebSockets();

        for (const socket of sockets) {
            refuseSocket(socket, reason, message);
        }

        this.jobs.failAll(reason, message);

        return Promise.resolve(sockets.length);
    }

    /** Claim a box-chosen request nonce until `expiresAt`; `false` for a nonce already claimed — the signed request is a replay. */
    public async claimNonce(nonce: string, expiresAt: number): Promise<boolean> {
        if (!isNonce(nonce) || !Number.isFinite(expiresAt)) {
            return false;
        }

        const now = Date.now();
        const key = `${NONCE_PREFIX}${nonce}`;
        const seen = await this.ctx.storage.get<number>(key);

        if (seen !== undefined && seen > now) {
            return false;
        }

        await this.ctx.storage.put(key, expiresAt);
        await this.sweepNonces(now);

        return true;
    }

    /** The control-plane store, or `undefined` without a `DB` binding. Protected so the unit tests can hand in a fake. */
    protected database(): ControlPlaneStore | undefined {
        return this.env.DB === undefined ? undefined : controlPlaneDatabase(this.env.DB as D1DatabaseLike);
    }

    /** Sockets of an authenticated box that the control plane has not refused. */
    private readySockets(): SessionSocket[] {
        return this.ctx.getWebSockets().filter((socket) => {
            const attachment = attachmentOf(socket);

            return attachment.phase === "ready" && attachment.closed !== true;
        });
    }

    private async acceptSocket(boxId: string): Promise<Response> {
        const sockets = this.ctx.getWebSockets();

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

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(openSession(boxId, Date.now()));
        // Armed for the handshake timeout; the tick re-arms itself while any socket is open.
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
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
                // The jobs sent on it fail now — their `result` would arrive on a socket
                // that is gone — rather than hold a caller until their timeout.
                for (const other of this.readySockets()) {
                    if (other !== socket) {
                        refuseSocket(other, "SUPERSEDED", "a newer session for this box authenticated");
                        this.jobs.failOwner(other, "SUPERSEDED", "the box reconnected before the job finished; its result will not arrive");
                    }
                }

                const fleets = this.takeFleets(effect.nonce);

                await recordHello(database, attachment.boxId, { ...effect.hello, ...(fleets === undefined ? {} : { fleets }) }, now);
                await this.ctx.storage.put("seenWrittenAt", now);
                await this.pushRoutes();
                await this.replayDesiredRelease(database, socket, attachment.boxId, effect.hello.versions);
                break;
            }
            case "hello": {
                this.holdFleets(effect.nonce, effect.fleets);
                break;
            }
            case "pong": {
                const writtenAt = (await this.ctx.storage.get<number>("seenWrittenAt")) ?? 0;

                if (now - writtenAt >= SEEN_WRITE_INTERVAL_MS) {
                    await markSeen(database, attachment.boxId, now);
                    await this.ctx.storage.put("seenWrittenAt", now);
                }

                break;
            }
            case "progress": {
                this.jobs.progress(effect.message);
                break;
            }
            case "report": {
                await this.recordReport(socket, database, attachment.boxId, effect.message, now);
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

    /** Hold a challenged `hello`'s fleets until its `auth`, dropping the oldest past one per possible handshake. */
    private holdFleets(nonce: string, fleets: FleetSummary[]): void {
        this.pendingFleets.set(nonce, fleets);

        for (const held of this.pendingFleets.keys()) {
            if (this.pendingFleets.size <= MAX_SOCKETS) {
                break;
            }

            this.pendingFleets.delete(held);
        }
    }

    /** The fleets held for the challenge `nonce` answered, forgotten once taken. */
    private takeFleets(nonce: string): FleetSummary[] | undefined {
        const fleets = this.pendingFleets.get(nonce);

        this.pendingFleets.delete(nonce);

        return fleets;
    }

    private async socketGone(socket: SessionSocket): Promise<void> {
        const attachment = attachmentOf(socket);
        const database = this.database();

        // Whatever happens to the box, the jobs sent on this socket can no longer finish.
        this.jobs.failOwner(socket, "BOX_OFFLINE", "the socket the job was sent on closed");

        if (attachment.phase === "ready" && this.readySockets().every((other) => other === socket) && database !== undefined) {
            // The box's authenticated session is gone and no other replaced it.
            this.jobs.failAll("BOX_OFFLINE", "the box's session ended");
            await markOffline(database, attachment.boxId);
        }
    }

    /**
     * Hand a box that just authenticated the `upgrade` it missed (plan 458 W2):
     * when its row names a desired release whose versions it does not run yet.
     * Fire-and-forget — the job settles on the box's `result` like any other,
     * and the next `hello` shows whether it took. It takes no job slot (nobody
     * waits on it, and a box that reconnects repeatedly would otherwise fill the
     * slots a deploy needs with upgrades), and it fails with its socket.
     */
    private async replayDesiredRelease(database: ControlPlaneStore, socket: SessionSocket, boxId: string, running: BoxVersions): Promise<void> {
        const box = await loadBox(database, boxId);
        const origin = this.env.LUNORA_ORIGIN_URL;

        if (box?.desiredReleaseId == null || origin === undefined) {
            return;
        }

        const { page } = await database.findMany("hostdReleases", { where: { releaseId: box.desiredReleaseId } });
        const release = page[0] as undefined | { releaseId: string; versions: BoxVersions };

        if (release === undefined || versionKey(release.versions) === versionKey(running)) {
            return;
        }

        const jobId = crypto.randomUUID();

        // Never rejects (the registry resolves every job); nothing waits on it.
        this.jobs.start(jobId, { counted: false, onProgress: () => undefined, owner: socket, timeoutMs: MAX_JOB_TIMEOUT_MS }).catch(() => undefined);
        sendFrame(socket, {
            job: {
                kind: "upgrade",
                manifestUrl: manifestUrlOf(origin, release.releaseId),
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
     *
     * Each window is processed once per box, whether or not it wrote a row: the
     * window is remembered in this object's storage, so replaying a report that
     * named nothing countable costs a storage read, not a D1 query. A socket
     * may send {@link MAX_REPORTS_PER_MINUTE}, and at most
     * {@link MAX_PENDING_REPORTS} wait their turn; the rest are dropped and logged.
     */
    private async recordReport(socket: SessionSocket, database: ControlPlaneStore, boxId: string, report: ReportMessage, now: number): Promise<void> {
        if (report.windowStart % REPORT_ALIGNMENT_MS !== 0) {
            return;
        }

        const minute = Math.floor(now / REPORT_ALIGNMENT_MS);
        const budget = this.reportBudgets.get(socket);
        const used = budget?.minute === minute ? budget.count : 0;

        if (used >= MAX_REPORTS_PER_MINUTE || this.pendingReports >= MAX_PENDING_REPORTS) {
            // eslint-disable-next-line no-console -- a dropped report is only visible here, in Workers Logs
            console.warn(
                `[box ${boxId}] report for window ${String(report.windowStart)} dropped: ${used >= MAX_REPORTS_PER_MINUTE ? "over the per-minute cap" : "too many reports pending"}`,
            );

            return;
        }

        this.reportBudgets.set(socket, { count: used + 1, minute });
        this.pendingReports += 1;

        const key = `${REPORT_PREFIX}${String(report.windowStart)}`;
        const record = async (): Promise<void> => {
            if ((await this.ctx.storage.get<number>(key)) !== undefined) {
                return;
            }

            const box = await loadBox(database, boxId);

            if (box === null || box.status === "revoked") {
                return;
            }

            const outcome = await recordBoxReport(database, box, report, now);

            // An out-of-range window cost nothing and is not remembered; anything
            // else — rows written, nothing countable, already in D1 — is done.
            if (!("dropped" in outcome && outcome.dropped === "out-of-range")) {
                await this.ctx.storage.put(key, report.windowStart);
            }
        };

        // Chained on a promise that never rejects, so one failed report cannot
        // wedge every report after it.
        this.reports = this.reports
            .then(record)
            .catch(() => undefined)
            .finally(() => {
                this.pendingReports -= 1;
            });

        await this.reports;
    }

    /**
     * Move the box's stored fleets on after one of its jobs finished (plan 458
     * W9). Best effort: the next `hello` reports the truth again, so a failed
     * write is logged, never the job's failure.
     */
    private async recordFleets(boxId: string, job: HostdJob, outcome: JobOutcome): Promise<void> {
        const database = this.database();

        if (database === undefined || !jobMovesFleets(job, outcome)) {
            return;
        }

        this.fleetWrites = this.fleetWrites
            .then(() => updateFleets(database, boxId, (fleets) => fleetsAfterJob(fleets, job, outcome)))
            .catch((error: unknown) => {
                // eslint-disable-next-line no-console -- a lost fleet write is only visible here, in Workers Logs
                console.warn(`[box ${boxId}] could not record its fleets after a ${job.kind} job: ${error instanceof Error ? error.message : String(error)}`);
            });

        await this.fleetWrites;
    }

    /** Forget processed report windows too old to be recorded anyway, a bounded batch at a time. */
    private async sweepReportWindows(now: number): Promise<void> {
        const windows = await this.ctx.storage.list<number>({ limit: 256, prefix: REPORT_PREFIX });

        for (const [key, windowStart] of windows) {
            if (windowStart < now - MAX_REPORT_AGE_MS) {
                // eslint-disable-next-line no-await-in-loop -- bounded batch; storage deletes are local
                await this.ctx.storage.delete(key);
            }
        }
    }

    /** Forget expired nonces, a bounded batch at a time. */
    private async sweepNonces(now: number): Promise<void> {
        const nonces = await this.ctx.storage.list<number>({ limit: 256, prefix: NONCE_PREFIX });

        for (const [key, expiresAt] of nonces) {
            if (expiresAt <= now) {
                // eslint-disable-next-line no-await-in-loop -- bounded batch; storage deletes are local
                await this.ctx.storage.delete(key);
            }
        }
    }
}
