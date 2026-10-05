/**
 * Deleting a fleet's data from the customer's bucket (plan 458 W4 `destroy`,
 * `deleteData`): every object under `fleets/{alias}/`. celld has no command
 * for it, so hostd lists and batch-deletes the prefix itself over the S3 API,
 * signed with the box's own bucket credentials (aws4fetch, SigV4). Path-style
 * URLs, which every S3-compatible store the box supports answers.
 */
import { createHash } from "node:crypto";

import { AwsClient } from "aws4fetch";

import type { BucketConfig } from "./config";
import { JobError } from "./job-error";

/** S3's `DeleteObjects` takes at most this many keys per call. */
const DELETE_BATCH = 1000;

/** Listing pages before giving up — 1,000 keys each. */
const MAX_PAGES = 10_000;

const TRUNCATED_PATTERN = /<IsTruncated>true<\/IsTruncated>/u;

const NEXT_TOKEN_PATTERN = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u;

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

const decodeXml = (text: string): string => text.replaceAll(/&(amp|apos|gt|lt|quot);/gu, (_match, name: string) => XML_ENTITIES[name] ?? "");

const encodeXml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** The bucket's base URL, path-style: `{endpoint}/{bucket}`. */
const bucketBaseUrl = (bucket: BucketConfig): string => {
    const endpoint = bucket.endpoint ?? `https://s3.${bucket.region ?? "us-east-1"}.amazonaws.com`;

    let trimmed = endpoint;

    while (trimmed.endsWith("/")) {
        trimmed = trimmed.slice(0, -1);
    }

    return `${trimmed}/${encodeURIComponent(bucket.name)}`;
};

interface BucketDeleteOptions {
    bucket: BucketConfig;
    credentials: Readonly<Record<string, string>>;
    /** Injected for tests. */
    fetch?: typeof fetch;
}

const clientOf = (options: BucketDeleteOptions): AwsClient => {
    const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = options.credentials;

    if (accessKeyId === undefined || secretAccessKey === undefined) {
        throw new JobError("BUCKET_FAILED", "no bucket credentials in the credentials file; hostd needs them to delete a fleet's data");
    }

    return new AwsClient({
        accessKeyId,
        region: options.bucket.region ?? "us-east-1",
        secretAccessKey,
        service: "s3",
        ...(sessionToken === undefined ? {} : { sessionToken }),
    });
};

const send = async (client: AwsClient, url: string, init: RequestInit, fetcher: typeof fetch): Promise<string> => {
    const signed = await client.sign(url, init);
    const response = await fetcher(signed);
    const body = await response.text();

    if (!response.ok) {
        throw new JobError("BUCKET_FAILED", `${init.method ?? "GET"} ${new URL(url).pathname} answered ${String(response.status)}: ${body.slice(0, 300)}`);
    }

    return body;
};

/**
 * Delete every object under `prefix` (which must end in `/`).
 * @returns how many objects were deleted
 * @throws {JobError} `BUCKET_FAILED` when the bucket refuses a list or a delete.
 */
const deletePrefix = async (prefix: string, options: BucketDeleteOptions): Promise<number> => {
    if (!prefix.endsWith("/") || prefix === "/") {
        throw new JobError("BUCKET_FAILED", `refusing to delete prefix ${JSON.stringify(prefix)}: it must name a directory`);
    }

    const client = clientOf(options);
    const fetcher = options.fetch ?? globalThis.fetch;
    const base = bucketBaseUrl(options.bucket);
    let deleted = 0;
    let token: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ "list-type": "2", prefix });

        if (token !== undefined) {
            query.set("continuation-token", token);
        }

        // eslint-disable-next-line no-await-in-loop -- each page names the next
        const listing = await send(client, `${base}?${query.toString()}`, { method: "GET" }, fetcher);
        const keys = [...listing.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((match) => decodeXml(match[1] ?? ""));

        for (let start = 0; start < keys.length; start += DELETE_BATCH) {
            const batch = keys.slice(start, start + DELETE_BATCH);
            const body = `<Delete><Quiet>true</Quiet>${batch.map((key) => `<Object><Key>${encodeXml(key)}</Key></Object>`).join("")}</Delete>`;

            // eslint-disable-next-line no-await-in-loop -- deletes run in order, a batch at a time
            await send(
                client,
                `${base}?delete=`,
                {
                    body,
                    headers: {
                        // S3 requires Content-MD5 on DeleteObjects as an integrity check of the body, not for security.
                        // eslint-disable-next-line sonarjs/hashing -- MD5 is what the S3 API mandates here
                        "content-md5": createHash("md5").update(body).digest("base64"),
                        "content-type": "application/xml",
                    },
                    method: "POST",
                },
                fetcher,
            );
            deleted += batch.length;
        }

        token = TRUNCATED_PATTERN.test(listing) ? decodeXml(NEXT_TOKEN_PATTERN.exec(listing)?.[1] ?? "") : undefined;

        if (token === undefined || token === "") {
            return deleted;
        }
    }

    throw new JobError("BUCKET_FAILED", `${prefix} has more objects than one destroy deletes; run it again`);
};

export type { BucketDeleteOptions };
export { bucketBaseUrl, deletePrefix };
