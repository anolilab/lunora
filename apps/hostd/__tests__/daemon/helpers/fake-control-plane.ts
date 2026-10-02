/**
 * An in-process stand-in for Lunora Cloud, as the box sees it (protocol
 * README §2, §6; `apps/cloud/src/deploy/routes/boxes.ts`).
 *
 * `POST /v1/boxes/enrol` trades a token for a box id and keeps the key.
 * `GET /v1/boxes/connect?box=` is the WebSocket: `hello`, `challenge`, `auth`
 * (verified against the enrolled key), `routes`, then jobs on demand.
 * `GET /v1/boxes/releases/:id` and `GET /v1/hostd/releases/:id/manifest` are
 * box-signed and verified as the control plane does (timestamp window,
 * single-use nonce, signature). `/s3/{bucket}` is a minimal S3
 * (ListObjectsV2 + DeleteObjects) for a destroy's `deleteData`. `POST
 * /v1/logs` keeps the OTLP log exports the box forwards.
 */
import { createPublicKey, verify } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { decodeBoxMessage, encodeMessage } from "../../../src/wire/codec";
import { challengeSigningPayload, HOSTD_REQUEST_HEADERS, requestSigningPayload } from "../../../src/wire/signing";
import type { BoxMessage, CloudMessage, ConfigMessage, HelloMessage, HostdJob, ResultMessage, RouteEntry } from "../../../src/wire/types";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type OtlpAttribute = { key: string; value: { stringValue: string } };

/** One resource of an OTLP/JSON logs export, as far as the box fills it. */
interface OtlpResourceLogs {
    resource: { attributes: OtlpAttribute[] };
    scopeLogs: { logRecords: { attributes: OtlpAttribute[]; body: { stringValue: string }; severityText: string }[] }[];
}

interface JobOutcome {
    progress: string[];
    result: ResultMessage;
}

interface SignedRequestRecord {
    headers: Record<string, string | undefined>;
    path: string;
    verified: boolean;
}

const verifyWithRawKey = (publicKey: string, signature: string, payload: Uint8Array): boolean => {
    try {
        const key = createPublicKey({ format: "der", key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64url")]), type: "spki" });

        return verify(undefined, payload, key, Buffer.from(signature, "base64url"));
    } catch {
        return false;
    }
};

/** A request's path and query, without building a URL against a made-up origin. */
const targetOf = (request: IncomingMessage): { pathname: string; searchParams: URLSearchParams } => {
    const [pathname = "/", query = ""] = (request.url ?? "/").split("?", 2);

    return { pathname, searchParams: new URLSearchParams(query) };
};

/** A ListObjectsV2 answer naming `keys`, never truncated. */
const listResult = (keys: ReadonlyArray<string>): string => {
    const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("");

    return ["<ListBucketResult>", "<IsTruncated>false</IsTruncated>", contents, "</ListBucketResult>"].join("");
};

const readBody = async (request: IncomingMessage): Promise<string> => {
    let body = "";

    for await (const chunk of request) {
        body += String(chunk);
    }

    return body;
};

class FakeControlPlane {
    public readonly boxId = "box_test_1";

    public readonly hostname = "btest00001.boxes.test";

    /** The enrolled box's raw public key; set by enrol or directly by a test. */
    public publicKey: string | undefined;

    public readonly enrolments: Record<string, unknown>[] = [];

    /** Every frame the box sent, decoded. */
    public readonly received: BoxMessage[] = [];

    public readonly signedRequests: SignedRequestRecord[] = [];

    /** Stored releases by deployment id: the JSON body served at `/v1/boxes/releases/:id`. */
    public readonly releases = new Map<string, string>();

    /** Manifest envelopes by release id. */
    public readonly manifests = new Map<string, string>();

    /** The fake bucket: object keys by bucket. */
    public readonly objects = new Map<string, Set<string>>();

    public routes: RouteEntry[] = [];

    /** The `config` sent after every `auth`; set with `pushConfig`. */
    public config: ConfigMessage | undefined;

    /** Every OTLP logs export the box posted to `/v1/logs`: its `Authorization` header and parsed body. */
    public readonly logExports: { authorization: string | undefined; body: { resourceLogs: OtlpResourceLogs[] } }[] = [];

    /** How many sockets authenticated. */
    public authentications = 0;

    /** Connections opened, authenticated or not. */
    public connections = 0;

    /** Refuse the next `hello` with this `error` frame and close. */
    public refuseNext: { code: string; message: string } | undefined;

    private readonly http: Server;

    private readonly wss = new WebSocketServer({ noServer: true });

    private socket: WebSocket | undefined;

    private readonly seenNonces = new Set<string>();

    private readonly pending = new Map<string, { progress: string[]; resolve: (outcome: JobOutcome) => void }>();

    private readonly waiters: { predicate: (message: BoxMessage) => boolean; resolve: (message: BoxMessage) => void }[] = [];

    private readonly readyWaiters: (() => void)[] = [];

    private jobCounter = 0;

    public constructor() {
        this.http = createServer((request, response) => {
            this.respond(request, response).catch(() => {
                response.destroy();
            });
        });
        this.http.on("upgrade", (request, socket, head) => {
            const url = targetOf(request);

            if (url.pathname !== "/v1/boxes/connect" || url.searchParams.get("box") !== this.boxId) {
                socket.destroy();

                return;
            }

            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.accept(ws);
            });
        });
    }

    /** The origin the box talks to. */
    public get origin(): string {
        return `http://127.0.0.1:${String((this.http.address() as AddressInfo).port)}`;
    }

    public async listen(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.http.listen(0, "127.0.0.1", () => {
                resolve();
            });
        });
    }

    public async close(): Promise<void> {
        for (const client of this.wss.clients) {
            client.terminate();
        }

        await new Promise<void>((resolve) => {
            this.wss.close(() => {
                resolve();
            });
        });
        await new Promise<void>((resolve) => {
            this.http.close(() => {
                resolve();
            });
            this.http.closeAllConnections();
        });
    }

    /** Resolve once a socket has authenticated (at least `count` times in all). */
    public async authenticated(count = 1): Promise<void> {
        while (this.authentications < count) {
            // eslint-disable-next-line no-await-in-loop -- wait for each authentication in turn
            await new Promise<void>((resolve) => {
                this.readyWaiters.push(resolve);
            });
        }
    }

    /** Resolve with the next frame from the box matching `predicate` (or one already received). */
    public async nextFrame(predicate: (message: BoxMessage) => boolean): Promise<BoxMessage> {
        return new Promise((resolve) => {
            this.waiters.push({ predicate, resolve });
        });
    }

    /** Send a raw frame to the box. */
    public send(message: CloudMessage): void {
        this.socket?.send(encodeMessage(message));
    }

    /** Send a `config`, now and after every later `auth`. */
    public pushConfig(config: Omit<ConfigMessage, "type">): void {
        this.config = { ...config, type: "config" };
        this.send(this.config);
    }

    /** Every log record the box has forwarded so far, with its resource's `service.name`. */
    public get forwardedLogs(): { attributes: Record<string, string>; body: string; service: string; severity: string }[] {
        const forwarded: { attributes: Record<string, string>; body: string; service: string; severity: string }[] = [];

        for (const { body } of this.logExports) {
            for (const resource of body.resourceLogs) {
                const service = resource.resource.attributes.find((entry) => entry.key === "service.name")?.value.stringValue ?? "";

                for (const record of resource.scopeLogs.flatMap((scope) => scope.logRecords)) {
                    forwarded.push({
                        attributes: Object.fromEntries(record.attributes.map((entry) => [entry.key, entry.value.stringValue])),
                        body: record.body.stringValue,
                        service,
                        severity: record.severityText,
                    });
                }
            }
        }

        return forwarded;
    }

    /** Push a routing table. */
    public pushRoutes(table: RouteEntry[]): void {
        this.routes = table;
        this.send({ table, type: "routes" });
    }

    /** Run a job on the box and resolve with its progress and result. */
    public async dispatch(job: HostdJob): Promise<JobOutcome> {
        this.jobCounter += 1;

        const jobId = `job_${String(this.jobCounter)}`;
        const outcome = new Promise<JobOutcome>((resolve) => {
            this.pending.set(jobId, { progress: [], resolve });
        });

        this.send({ job, jobId, type: "job" });

        return outcome;
    }

    /** Refuse the box on the live socket, as the session DO does: one `error`, then close 1008 with the code. */
    public refuse(code: string, message: string): void {
        this.send({ code, message, type: "error" });
        this.socket?.close(1008, code);
    }

    /** Enrol `publicKey` as the box's key, as `POST /v1/boxes/enrol` would. */
    public trust(publicKey: string): void {
        this.publicKey = publicKey;
    }

    /** Store objects in the fake bucket. */
    public putObjects(bucket: string, keys: string[]): void {
        this.objects.set(bucket, new Set([...(this.objects.get(bucket) ?? []), ...keys]));
    }

    private accept(ws: WebSocket): void {
        this.connections += 1;

        let hello: HelloMessage | undefined;
        let nonce: string | undefined;
        let ready = false;

        ws.on("message", (data: Buffer) => {
            const decoded = decodeBoxMessage(data.toString("utf8"));

            if (!decoded.ok) {
                ws.close(1008, "BAD_MESSAGE");

                return;
            }

            const { message } = decoded;

            this.received.push(message);

            if (message.type === "hello") {
                if (this.refuseNext !== undefined) {
                    const refusal = this.refuseNext;

                    this.refuseNext = undefined;
                    ws.send(encodeMessage({ ...refusal, type: "error" }));
                    ws.close(1008, refusal.code);

                    return;
                }

                hello = message;
                nonce = Buffer.from(`nonce-${String(this.connections)}-0123456789abcdef`).toString("base64url");
                ws.send(encodeMessage({ nonce, type: "challenge" }));

                return;
            }

            if (message.type === "auth") {
                const ok =
                    hello !== undefined &&
                    nonce !== undefined &&
                    this.publicKey !== undefined &&
                    verifyWithRawKey(this.publicKey, message.signature, challengeSigningPayload(nonce, this.boxId));

                if (!ok) {
                    ws.send(encodeMessage({ code: "AUTH_FAILED", message: "bad signature", type: "error" }));
                    ws.close(1008, "AUTH_FAILED");

                    return;
                }

                ready = true;
                this.socket = ws;
                this.authentications += 1;
                ws.send(encodeMessage({ table: this.routes, type: "routes" }));

                if (this.config !== undefined) {
                    ws.send(encodeMessage(this.config));
                }

                for (const resolve of this.readyWaiters.splice(0)) {
                    resolve();
                }

                return;
            }

            if (!ready) {
                ws.close(1008, "BAD_MESSAGE");

                return;
            }

            this.onReadyFrame(message);
        });
    }

    private onReadyFrame(message: BoxMessage): void {
        if (message.type === "progress") {
            this.pending.get(message.jobId)?.progress.push(message.line);
        }

        if (message.type === "result") {
            const job = this.pending.get(message.jobId);

            if (job !== undefined) {
                this.pending.delete(message.jobId);
                job.resolve({ progress: job.progress, result: message });
            }
        }

        for (const waiter of this.waiters) {
            if (waiter.predicate(message)) {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve(message);
            }
        }
    }

    /** Verify a box-signed request as `verifyBoxRequest` does. */
    private verifySigned(request: IncomingMessage, path: string): boolean {
        const header = (name: string): string | undefined => {
            const value = request.headers[name];

            return typeof value === "string" ? value : undefined;
        };
        const boxId = header(HOSTD_REQUEST_HEADERS.boxId);
        const nonce = header(HOSTD_REQUEST_HEADERS.nonce);
        const signature = header(HOSTD_REQUEST_HEADERS.signature);
        const timestamp = Number(header(HOSTD_REQUEST_HEADERS.timestamp) ?? "NaN");
        let verified = false;

        if (
            boxId === this.boxId &&
            nonce !== undefined &&
            signature !== undefined &&
            Number.isSafeInteger(timestamp) &&
            Math.abs(Date.now() - timestamp) <= 300_000
        ) {
            const payload = requestSigningPayload({ boxId, method: request.method ?? "GET", nonce, path, timestamp });

            verified = this.publicKey !== undefined && !this.seenNonces.has(nonce) && verifyWithRawKey(this.publicKey, signature, payload);
            this.seenNonces.add(nonce);
        }

        this.signedRequests.push({
            headers: Object.fromEntries(Object.values(HOSTD_REQUEST_HEADERS).map((name) => [name, header(name)])),
            path,
            verified,
        });

        return verified;
    }

    private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const { body, status } = await this.route(request);

        response.writeHead(status, { "content-type": status === 200 && body.startsWith("<") ? "application/xml" : "application/json" }).end(body);
    }

    private async route(request: IncomingMessage): Promise<{ body: string; status: number }> {
        const url = targetOf(request);
        const path = request.url ?? "/";

        if (request.method === "POST" && url.pathname === "/v1/boxes/enrol") {
            const body = JSON.parse(await readBody(request)) as Record<string, unknown>;

            this.enrolments.push(body);

            if (typeof body["token"] !== "string" || !/^lbe_[\da-f]{64}$/u.test(body["token"])) {
                return { body: JSON.stringify({ error: "invalid or expired enrolment token" }), status: 403 };
            }

            this.publicKey = body["publicKey"] as string;

            return { body: JSON.stringify({ boxId: this.boxId, hostname: this.hostname, organizationId: "org_1", slug: "btest00001" }), status: 200 };
        }

        const release = /^\/v1\/boxes\/releases\/([\w-]+)$/u.exec(url.pathname);
        const manifest = /^\/v1\/hostd\/releases\/([\w-]+)\/manifest$/u.exec(url.pathname);

        if (release !== null || manifest !== null) {
            if (!this.verifySigned(request, path)) {
                return { body: JSON.stringify({ error: "invalid box signature" }), status: 401 };
            }

            const stored = release === null ? this.manifests.get(manifest?.[1] ?? "") : this.releases.get(release[1] ?? "");

            return stored === undefined ? { body: JSON.stringify({ error: "not found" }), status: 404 } : { body: stored, status: 200 };
        }

        if (request.method === "POST" && url.pathname === "/v1/logs") {
            this.logExports.push({
                authorization: request.headers.authorization,
                body: JSON.parse(await readBody(request)) as { resourceLogs: OtlpResourceLogs[] },
            });

            return { body: JSON.stringify({ partialSuccess: {} }), status: 200 };
        }

        if (url.pathname.startsWith("/s3/")) {
            return this.s3(request, url);
        }

        return { body: JSON.stringify({ error: "not found" }), status: 404 };
    }

    private async s3(request: IncomingMessage, url: { pathname: string; searchParams: URLSearchParams }): Promise<{ body: string; status: number }> {
        const bucket = decodeURIComponent(url.pathname.slice("/s3/".length));
        const keys = this.objects.get(bucket) ?? new Set<string>();

        if (request.headers.authorization?.startsWith("AWS4-HMAC-SHA256") !== true) {
            return { body: "<Error><Code>AccessDenied</Code></Error>", status: 403 };
        }

        if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
            const prefix = url.searchParams.get("prefix") ?? "";
            const matching = [...keys].filter((key) => key.startsWith(prefix)).toSorted((a, b) => a.localeCompare(b));

            return {
                body: listResult(matching),
                status: 200,
            };
        }

        if (request.method === "POST" && url.searchParams.has("delete")) {
            const body = await readBody(request);

            for (const match of body.matchAll(/<Key>([^<]*)<\/Key>/gu)) {
                keys.delete(match[1] ?? "");
            }

            return { body: "<DeleteResult></DeleteResult>", status: 200 };
        }

        return { body: "<Error><Code>NotImplemented</Code></Error>", status: 501 };
    }
}

export type { JobOutcome, SignedRequestRecord };
export { FakeControlPlane };
