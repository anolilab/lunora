/**
 * Download links for export archives. The package asks the host for a signed URL. This example has no
 * object storage, so the archive stays in the `exportFiles` table, and the link is an HMAC over the
 * file's key and expiry. The route in `lunora/http.ts` checks the link before it reads the file.
 *
 * The signing key is `PRIVACY_FILE_SECRET`, a Worker secret or a line in `.dev.vars`. Without it no
 * link can be minted, and an existing link is refused, rather than signing with an empty key.
 */
import { LunoraError } from "lunorash/errors";

/** The route `lunora/http.ts` serves. */
export const FILE_ROUTE = "/privacy/files";

/** An archive part as `exportFiles` keeps it. `base64` bodies are binary, `text` bodies are not. */
export interface StoredFile {
    readonly body: string;
    readonly encoding: "base64" | "text";
    readonly name: string;
}

/** The query parameters of a download link. `null` when the URL does not carry one. */
export interface FileLink {
    readonly exp: null | string;
    readonly key: null | string;
    readonly sig: null | string;
}

const encoder = new TextEncoder();

/** A whole lowercase hex string, and one of its byte pairs. */
const HEX_PATTERN = /^(?:[\da-f]{2})+$/u;
const HEX_PAIR = /../gu;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
};

/** The signing key, or `undefined` when no secret is set. */
const hmacKey = async (usage: "sign" | "verify"): Promise<CryptoKey | undefined> => {
    const secret = process.env.PRIVACY_FILE_SECRET;

    if (secret === undefined || secret === "") {
        return undefined;
    }

    return crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [usage]);
};

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The bytes of a lowercase hex string, or `undefined` when it is not one. */
const fromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined =>
    HEX_PATTERN.test(hex) ? Uint8Array.from(hex.match(HEX_PAIR) ?? [], (pair) => Number.parseInt(pair, 16)) : undefined;

/** The signed message. The expiry is in it, so a link cannot be extended by editing `exp`. */
const messageOf = (key: string, expires: number): Uint8Array<ArrayBuffer> => encoder.encode(`${String(expires)}\n${key}`);

/**
 * A link for the archive part `key` names, valid for `ttlSeconds` from `nowMs`. It is a path on this
 * app's origin, so the browser needs no host to open it.
 */
export const signFileLink = async (key: string, ttlSeconds: number, nowMs: number): Promise<string> => {
    const signingKey = await hmacKey("sign");

    if (signingKey === undefined) {
        throw new LunoraError("INTERNAL", "Set PRIVACY_FILE_SECRET so download links can be signed.");
    }

    const expires = Math.floor(nowMs / 1000) + ttlSeconds;
    const signature = toHex(await crypto.subtle.sign("HMAC", signingKey, messageOf(key, expires)));

    return `${FILE_ROUTE}?${new URLSearchParams({ exp: String(expires), key, sig: signature }).toString()}`;
};

/** Whether a link was signed with this secret, names a key, and has not expired. Any doubt is a refusal. */
const linkIsValid = async (link: FileLink, nowMs: number): Promise<boolean> => {
    const verifyKey = await hmacKey("verify");
    const signature = fromHex(link.sig ?? "");
    const expires = Number(link.exp);

    if (verifyKey === undefined || link.key === null || signature === undefined || !Number.isInteger(expires) || expires <= nowMs / 1000) {
        return false;
    }

    return crypto.subtle.verify("HMAC", verifyKey, signature, messageOf(link.key, expires));
};

const contentTypeOf = (name: string): string => {
    const dot = name.lastIndexOf(".");

    return (dot === -1 ? undefined : CONTENT_TYPES[name.slice(dot)]) ?? "application/octet-stream";
};

/**
 * The response for a download link: the archive part, or a 404. Every refusal is the same 404, so a
 * caller cannot tell a forged link from an expired one or from a file that does not exist.
 */
export const fileResponse = async (link: FileLink, nowMs: number, read: (key: string) => Promise<null | StoredFile | undefined>): Promise<Response> => {
    const notFound = (): Response => new Response("Not found", { status: 404 });

    if (link.key === null || !(await linkIsValid(link, nowMs))) {
        return notFound();
    }

    const file = await read(link.key);

    if (file === null || file === undefined) {
        return notFound();
    }

    const body = file.encoding === "base64" ? Uint8Array.from(atob(file.body), (character) => character.codePointAt(0) ?? 0) : encoder.encode(file.body);

    return new Response(body, {
        headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${file.name.replaceAll(/[^\w.-]/gu, "_")}"`,
            "content-type": contentTypeOf(file.name),
        },
    });
};
