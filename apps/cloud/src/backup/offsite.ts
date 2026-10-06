/**
 * The off-site copy of every backup: an R2 bucket in a second Cloudflare
 * account, reached over R2's S3 API (GAPS.md D1).
 *
 * A Worker's R2 binding cannot address another account, so the primary
 * buckets (`BACKUPS`, `TENANT_BACKUPS`) die with the cell's account. This copies
 * each control-plane dump and tenant snapshot, under the same key, to a bucket
 * the cell's account does not own — signed with SigV4 by `aws4fetch`, under an
 * R2 API token scoped to that one bucket.
 *
 * Inert unless all four `BACKUP_OFFSITE_*` values are set. The credential only
 * ever travels in the signed `authorization` header: errors carry the HTTP status
 * and S3 error code, never a key, a signature or object bytes.
 */
import { AwsClient } from "aws4fetch";

import { stripTrailingSlashes } from "../admin/proxy";
import type { MultipartBucket, UploadedPart } from "./multipart";
import type { BackupListing } from "./sweep";

/**
 * The env slice the off-site bucket reads. A `type`, not an `interface`: it is
 * intersected into `ControlPlaneEnv` / `RouterEnv`, which must stay assignable
 * to `Record&lt;string, unknown>` (see `src/control-plane-env.ts`).
 */
export type OffsiteEnvironment = {
    /** Access key id of an R2 API token (Object Read & Write) on the off-site bucket. */
    BACKUP_OFFSITE_ACCESS_KEY_ID?: string;
    /** The off-site bucket's name. */
    BACKUP_OFFSITE_BUCKET?: string;
    /** The other account's R2 S3 API endpoint, as the dashboard shows it, without the bucket path. */
    BACKUP_OFFSITE_ENDPOINT?: string;
    /** That token's secret access key. */
    BACKUP_OFFSITE_SECRET_ACCESS_KEY?: string;
};

/** What the sweeps need from the off-site bucket: streamed writes, and the listing + deletes retention prunes with. */
export interface OffsiteBucket extends MultipartBucket {
    delete: (keys: string[]) => Promise<void>;
    list: (options: { cursor?: string; prefix: string }) => Promise<BackupListing>;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

const unescapeXml = (value: string): string => value.replaceAll(/&(amp|apos|gt|lt|quot);/gu, (_match, name: string) => XML_ENTITIES[name] ?? "");

/** The text of the first `tag` element in `xml`. S3 answers flat, well-known documents, so a scan is enough. */
const xmlValue = (xml: string, tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "u").exec(xml);

    return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
};

const failure = async (operation: string, response: Response): Promise<Error> => {
    const code = xmlValue(await response.text().catch(() => ""), "Code");

    return new Error(`off-site ${operation} failed: HTTP ${String(response.status)}${code ? ` ${code}` : ""}`);
};

/** The off-site bucket, or `undefined` when it is not fully configured. `fetch` is injected for tests. */
export const offsiteBucket = (environment: OffsiteEnvironment, fetchImpl: typeof globalThis.fetch = globalThis.fetch): OffsiteBucket | undefined => {
    const {
        BACKUP_OFFSITE_ACCESS_KEY_ID: accessKeyId,
        BACKUP_OFFSITE_BUCKET: bucket,
        BACKUP_OFFSITE_ENDPOINT: endpoint,
        BACKUP_OFFSITE_SECRET_ACCESS_KEY: secretAccessKey,
    } = environment;

    if (!accessKeyId || !bucket || !endpoint || !secretAccessKey) {
        // Some but not all set reads as a typo, not as "off": say so, by name only.
        if (accessKeyId || bucket || endpoint || secretAccessKey) {
            // eslint-disable-next-line no-console -- variable names only, never a value
            console.warn("[backup-offsite] off-site copy is off: set all four BACKUP_OFFSITE_* values or none");
        }

        return undefined;
    }

    // No retries in the signer: a failed copy is recorded and the next backup copies again.
    const client = new AwsClient({ accessKeyId, region: "auto", retries: 0, secretAccessKey, service: "s3" });
    const base = `${stripTrailingSlashes(endpoint)}/${encodeURIComponent(bucket)}`;
    const objectUrl = (key: string): string =>
        `${base}/${key
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`;
    const send = async (url: string, init: RequestInit = {}): Promise<Response> => fetchImpl(await client.sign(url, init));

    return {
        createMultipartUpload: async (key, options) => {
            const contentType = options?.httpMetadata?.contentType;
            const created = await send(`${objectUrl(key)}?uploads`, { headers: contentType ? { "content-type": contentType } : {}, method: "POST" });

            if (!created.ok) {
                throw await failure("upload start", created);
            }

            const uploadId = xmlValue(await created.text(), "UploadId");

            if (!uploadId) {
                throw new Error("off-site upload start failed: no UploadId in the response");
            }

            const uploadUrl = `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`;

            return {
                abort: async () => {
                    await send(uploadUrl, { method: "DELETE" });
                },
                complete: async (parts: UploadedPart[]) => {
                    const body = `<CompleteMultipartUpload>${parts
                        .map((part) => `<Part><PartNumber>${String(part.partNumber)}</PartNumber><ETag>${part.etag}</ETag></Part>`)
                        .join("")}</CompleteMultipartUpload>`;
                    const completed = await send(uploadUrl, { body, headers: { "content-type": "application/xml" }, method: "POST" });
                    // S3 can answer 200 and still fail the completion in the body.
                    const text = completed.ok ? await completed.text() : "";

                    if (!completed.ok || text.includes("<Error>")) {
                        throw completed.ok
                            ? new Error(`off-site upload complete failed: ${xmlValue(text, "Code") ?? "unknown error"}`)
                            : await failure("upload complete", completed);
                    }
                },
                uploadPart: async (partNumber, value) => {
                    const uploaded = await send(`${objectUrl(key)}?partNumber=${String(partNumber)}&uploadId=${encodeURIComponent(uploadId)}`, {
                        body: value,
                        method: "PUT",
                    });
                    const etag = uploaded.headers.get("etag");

                    if (!uploaded.ok || !etag) {
                        throw await failure(`part ${String(partNumber)} upload`, uploaded);
                    }

                    return { etag, partNumber };
                },
            };
        },
        delete: async (keys) => {
            for (const key of keys) {
                // One DELETE per key (DeleteObjects needs a Content-MD5); a prune page is small.
                // eslint-disable-next-line no-await-in-loop -- sequential keeps the request rate flat
                const deleted = await send(objectUrl(key), { method: "DELETE" });

                // 404: already gone, which is what a delete wants.
                if (!deleted.ok && deleted.status !== 404) {
                    // eslint-disable-next-line no-await-in-loop -- leaves the loop
                    throw await failure("delete", deleted);
                }
            }
        },
        list: async ({ cursor, prefix }) => {
            const query = new URLSearchParams({ "list-type": "2", prefix, ...(cursor === undefined ? {} : { "continuation-token": cursor }) });
            const listed = await send(`${base}?${query.toString()}`);

            if (!listed.ok) {
                throw await failure("list", listed);
            }

            const xml = await listed.text();
            const objects = [...xml.matchAll(/<Contents>(.*?)<\/Contents>/gsu)].flatMap(([, entry = ""]) => {
                const key = xmlValue(entry, "Key");
                const modified = xmlValue(entry, "LastModified");

                return key === undefined || modified === undefined ? [] : [{ key, uploaded: new Date(modified) }];
            });
            const next = xmlValue(xml, "NextContinuationToken");

            return { ...(next === undefined ? {} : { cursor: next }), objects, truncated: xmlValue(xml, "IsTruncated") === "true" };
        },
    };
};
