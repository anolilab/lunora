/**
 * One bearer-token JSON POST to a Cloudflare SQL REST endpoint, under a single
 * deadline that bounds the fetch AND the body read — a hang after the headers is
 * the harder failure to notice. Shared by the Analytics SQL REST transport and
 * the R2 SQL client (`@lunora/bindings`), which each map the outcome onto their
 * own error.
 *
 * Three outcomes, so no caller re-derives "was that the deadline":
 * - `{ ok: true, json }` — a 2xx whose body parsed as JSON;
 * - `{ ok: false, status, text }` — a non-2xx (the status is the diagnosis, the
 *   text detail; a deadline firing while the error body is read keeps the
 *   status), or a 2xx whose body is not JSON (reported as `502`);
 * - `{ timedOut: true }` — the deadline fired before a status or a JSON body.
 *
 * Anything else `fetch` throws — DNS, a reset, a plain `TypeError` — propagates
 * unchanged for the caller to classify.
 *
 * Zero-dependency and bundler-inlined (see `shared/`): relative imports only.
 */
import { abortDeadline } from "./abort-deadline";

type SqlRestPostOutcome = { json: unknown; ok: true } | { ok: false; status: number; text: string } | { timedOut: true };

interface SqlRestPostRequest {
    apiToken: string;
    /** Serialised with `JSON.stringify`. */
    body: unknown;
    fetch: typeof globalThis.fetch;
    /** Bounds the fetch and the body read together. */
    timeoutMs: number;
    url: string;
}

const sqlRestPost = async ({ apiToken, body, fetch: fetchImpl, timeoutMs, url }: SqlRestPostRequest): Promise<SqlRestPostOutcome> => {
    const deadline = abortDeadline(undefined, timeoutMs, () => new DOMException(`deadline of ${String(timeoutMs)}ms exceeded`, "TimeoutError"));
    const timedOut = (): boolean => deadline.signal?.aborted === true;

    try {
        const response = await fetchImpl(url, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
            method: "POST",
            signal: deadline.signal,
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "<error body unavailable: the request deadline fired before it was read>");

            return { ok: false, status: response.status, text };
        }

        try {
            return { json: await response.json(), ok: true };
        } catch (error) {
            if (timedOut()) {
                return { timedOut: true };
            }

            // A 2xx with a non-JSON body: typically an intermediary's HTML page.
            return { ok: false, status: 502, text: `the endpoint returned a non-JSON body (HTTP ${String(response.status)}): ${String(error)}` };
        }
    } catch (error) {
        if (timedOut()) {
            return { timedOut: true };
        }

        throw error;
    } finally {
        deadline.dispose();
    }
};

export { sqlRestPost };
export type { SqlRestPostOutcome, SqlRestPostRequest };
