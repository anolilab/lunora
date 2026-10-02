/**
 * The control plane's typed caller for a box's `BoxSessionDO` (plan 458 G11):
 * run a job, push the routing table, close the session, claim a request nonce.
 * Over the Durable Object namespace binding, so it never leaves Cloudflare —
 * the public router forwards nothing but the box's own upgrade to the object.
 */
import type { HostdJob } from "@lunora/hostd/protocol";

import readJson from "../read-json";
import type { JobOutcome } from "./jobs";

/** The slice of a Durable Object namespace binding the client uses. */
export interface BoxSessionNamespace {
    get: (id: never) => { fetch: (request: Request) => Promise<Response> };
    idFromName: (name: string) => unknown;
}

/** A refusal from the session itself, before a job reached the box — `BOX_OFFLINE` (plan 458 D14), `BOX_BUSY`, `BAD_JOB`. */
export class BoxSessionError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
        super(message);
        this.name = "BoxSessionError";
        this.code = code;
    }
}

export interface BoxSession {
    /** Forget-proof replay protection: `true` the first time `nonce` is claimed before `expiresAt`, `false` for a replay. */
    claimNonce: (nonce: string, expiresAt: number) => Promise<boolean>;
    /** Refuse every socket of the box with `code` (revocation). */
    close: (code: string, message: string) => Promise<void>;

    /**
     * Run `job` on the box: resolves with its result once the box answers, the
     * job times out, or the box disconnects; each `progress` line goes to
     * `onProgress` as it arrives.
     * @throws {BoxSessionError} when the job could not be handed to the box at all.
     */
    dispatch: (job: HostdJob, options?: { onProgress?: (line: string) => void; timeoutMs?: number }) => Promise<JobOutcome>;
    /** Recompute and push the box's routing table; `false` when the box is not connected (it gets it on connect). */
    pushRoutes: () => Promise<boolean>;
}

/** The host is never resolved — the request goes straight to the object — so it only has to be a valid URL. */
const SESSION_ORIGIN = "https://box-session.internal";

type StreamFrame = (JobOutcome & { type: "result" }) | { line: string; type: "progress" };

/** The complete NDJSON lines of a response body, as they arrive. */
const ndjsonLines = async function* (body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of body) {
        buffered += decoder.decode(chunk, { stream: true });

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        yield* lines.filter((line) => line.trim() !== "");
    }
};

/** Read the NDJSON a dispatch streams: progress lines, then one result. */
const readOutcome = async (response: Response, onProgress: (line: string) => void): Promise<JobOutcome> => {
    if (response.body === null) {
        throw new BoxSessionError("BAD_RESPONSE", "the box session answered no stream");
    }

    for await (const line of ndjsonLines(response.body)) {
        const frame = JSON.parse(line) as StreamFrame;

        if (frame.type === "result") {
            return { ok: frame.ok, ...(frame.error === undefined ? {} : { error: frame.error }), ...(frame.url === undefined ? {} : { url: frame.url }) };
        }

        onProgress(frame.line);
    }

    throw new BoxSessionError("BAD_RESPONSE", "the box session ended the job stream without a result");
};

/** The session of box `boxId`. */
export const boxSession = (namespace: BoxSessionNamespace, boxId: string): BoxSession => {
    const stub = namespace.get(namespace.idFromName(boxId) as never);
    const call = (path: string, body: unknown): Promise<Response> =>
        stub.fetch(
            new Request(`${SESSION_ORIGIN}${path}?box=${encodeURIComponent(boxId)}`, {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    const refused = async (response: Response): Promise<BoxSessionError> => {
        const body = await readJson<{ code?: string; message?: string }>(response).catch((): { code?: string; message?: string } => {
            return {};
        });

        return new BoxSessionError(body.code ?? "BOX_SESSION_ERROR", body.message ?? `the box session answered ${String(response.status)}`);
    };

    return {
        claimNonce: async (nonce, expiresAt) => {
            const response = await call("/nonce", { expiresAt, nonce });

            if (!response.ok) {
                throw await refused(response);
            }

            const body = await readJson<{ fresh?: boolean }>(response);

            return body.fresh === true;
        },
        close: async (code, message) => {
            const response = await call("/close", { code, message });

            if (!response.ok) {
                throw await refused(response);
            }
        },
        dispatch: async (job, options = {}) => {
            const response = await call("/dispatch", { job, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });

            if (!response.ok) {
                throw await refused(response);
            }

            return readOutcome(response, options.onProgress ?? (() => undefined));
        },
        pushRoutes: async () => {
            const response = await call("/routes", {});

            if (!response.ok) {
                throw await refused(response);
            }

            const body = await readJson<{ pushed?: boolean }>(response);

            return body.pushed === true;
        },
    };
};
