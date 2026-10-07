/**
 * Invocation lineage for recursion protection (plan 365 W5, D7/D8) — shared by
 * the dispatcher (`./worker.ts`) and the dispatch namespace's Outbound Worker
 * (`src/outbound/worker.ts`). Dependency-free: both are separate bundles.
 *
 * Lineage is decided server-side, never by the tenant:
 *
 * 1. The dispatcher knows each invocation's depth — 0 for a request from
 *    outside, or the depth carried by a VERIFIED lineage header — and hands it
 *    to the Outbound Worker through the dispatch binding's `parameters`, which
 *    tenant code cannot read or set.
 * 2. The Outbound Worker sees every `fetch()` the tenant makes. It removes any
 *    lineage header the tenant set and stamps its own: depth + 1, signed.
 * 3. A request that comes back through the dispatcher carries that header. The
 *    dispatcher verifies the signature and age, refuses a forged or stale one,
 *    and refuses past {@link MAX_LINEAGE_DEPTH} under the org's `terminate` policy.
 *
 * So a tenant can neither forge a lower depth (it has no key, and the Outbound
 * Worker overwrites what it sets) nor strip its depth (the Outbound Worker
 * re-adds it on every request). What escapes it is documented in the README:
 * calls that never leave through `fetch()` — Durable Object stubs, service
 * bindings — and loops through a third party that drops the header.
 */

/** The header the Outbound Worker stamps and the dispatcher verifies and strips. */
export const LINEAGE_HEADER = "x-lunora-lineage";

/** Invocations of one chain allowed before the next is refused — AWS Lambda's number, not an invented one. */
export const MAX_LINEAGE_DEPTH = 16;

/** How old (or far in the future) a signed header may be — enough for one hop, too short to stockpile. */
export const LINEAGE_MAX_AGE_SECONDS = 60;

/** One invocation's place in its chain. `root` is the id of the outside request that started it. */
export interface Lineage {
    depth: number;
    root: string;
}

const ROOT = /^[0-9a-f]{32}$/;
const HEADER = /^v1\.(\d{1,4})\.([0-9a-f]{32})\.(\d{1,12})\.([0-9a-f]{64})$/;
const PARAMETER = /^(\d{1,4})\.([0-9a-f]{32})$/;

const encoder = new TextEncoder();

const hmacKey = async (secret: string): Promise<CryptoKey> =>
    crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));

    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
};

/** A fresh chain root for a request from outside. */
export const newLineageRoot = (): string => crypto.randomUUID().replaceAll("-", "");

/** The binding parameter the dispatcher hands the Outbound Worker: `depth.root`. */
export const formatLineageParameter = (lineage: Lineage): string => `${String(lineage.depth)}.${lineage.root}`;

/** Parse the binding parameter, or `undefined` for anything malformed (the Outbound Worker then stamps nothing). */
export const parseLineageParameter = (value: unknown): Lineage | undefined => {
    const match = typeof value === "string" ? PARAMETER.exec(value) : null;

    return match ? { depth: Number(match[1]), root: match[2] ?? "" } : undefined;
};

/** The signed header for `lineage`, minted at `nowMs`. */
export const signLineage = async (secret: string, lineage: Lineage, nowMs: number): Promise<string> => {
    if (!ROOT.test(lineage.root) || !Number.isInteger(lineage.depth) || lineage.depth < 0 || lineage.depth > 9999) {
        throw new Error("invalid lineage");
    }

    const payload = `v1.${String(lineage.depth)}.${lineage.root}.${String(Math.floor(nowMs / 1000))}`;
    const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));

    return `${payload}.${toHex(signature)}`;
};

/**
 * The Outbound Worker's rewrite of one outgoing request: the tenant's lineage
 * header removed, and — when the secret and the dispatcher's `lineage`
 * parameter are both there — the platform's stamped, one hop deeper.
 */
export const stampLineage = async (request: Request, env: { lineage?: string; LUNORA_LINEAGE_SECRET?: string }, nowMs: number): Promise<Request> => {
    const headers = new Headers(request.headers);

    headers.delete(LINEAGE_HEADER);

    const current = parseLineageParameter(env.lineage);

    if (current !== undefined && env.LUNORA_LINEAGE_SECRET) {
        headers.set(LINEAGE_HEADER, await signLineage(env.LUNORA_LINEAGE_SECRET, { depth: current.depth + 1, root: current.root }, nowMs));
    }

    return new Request(request, { headers });
};

/** What an inbound lineage header says. */
export type InboundLineage = { lineage: Lineage; status: "valid" } | { status: "invalid" } | { status: "none" };

/**
 * Verify an inbound header. `none` when there is no header, or no secret to
 * verify one with (the feature is not deployed — inert, never a refusal);
 * `invalid` for a malformed, forged or stale one; otherwise its lineage.
 */
export const readLineage = async (header: null | string, secret: string | undefined, nowMs: number): Promise<InboundLineage> => {
    if (header === null || !secret) {
        return { status: "none" };
    }

    const match = HEADER.exec(header);

    if (!match) {
        return { status: "invalid" };
    }

    const [, depth = "", root = "", issuedAt = "", signature = ""] = match;

    if (Math.abs(nowMs / 1000 - Number(issuedAt)) > LINEAGE_MAX_AGE_SECONDS) {
        return { status: "invalid" };
    }

    // `verify`, not a string compare: constant-time by construction.
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromHex(signature), encoder.encode(`v1.${depth}.${root}.${issuedAt}`));

    return valid ? { lineage: { depth: Number(depth), root }, status: "valid" } : { status: "invalid" };
};
