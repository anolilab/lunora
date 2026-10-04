/**
 * `createR2UploadStorage`: an upload provider over R2's S3 API, for
 * `createUploadHandler`, built on `@visulima/storage`'s `aws-light` provider.
 */
import { LunoraError } from "@lunora/errors";
import { AwsLightStorage } from "@visulima/storage/provider/aws-light";

/** R2 (S3-compatible) credentials + bucket for {@link createR2UploadStorage}. */
interface R2UploadStorageOptions {
    /** R2 S3 API Access Key ID (from an R2 API token). */
    accessKeyId: string;
    /** Cloudflare account id — used to derive the R2 S3 endpoint host. */
    accountId: string;
    /** Target R2 bucket name. */
    bucket: string;

    /**
     * Explicit R2 S3 account endpoint, an absolute `https://` URL. The bucket
     * is appended as a path segment, unless the endpoint already names it
     * (as its last path segment, or as the host's first label). Defaults to
     * `https://<accountId>.r2.cloudflarestorage.com`. Pass this to pin a
     * jurisdiction (e.g. `https://<accountId>.eu.r2.cloudflarestorage.com`).
     */
    endpoint?: string;
    /** Client-side multipart part size (bytes or a size string like `"16MB"`). */
    partSize?: number | string;

    /**
     * Path prefix the handler is mounted on (must match the client endpoint's
     * path). Default `"/"`.
     */
    path?: string;
}

/**
 * Parse an explicit `endpoint`. Anything but an absolute `http(s)` URL is a
 * configuration error, reported as such rather than as `new URL`'s bare
 * `TypeError` (a schemeless `<account>.eu.r2.cloudflarestorage.com` is the usual one).
 */
const parseEndpoint = (endpoint: string): URL => {
    let url: URL | undefined;

    try {
        url = new URL(endpoint);
    } catch {
        url = undefined;
    }

    if (url?.protocol !== "https:" && url?.protocol !== "http:") {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/storage: createR2UploadStorage's endpoint must be an absolute URL such as https://<account>.r2.cloudflarestorage.com (received ${JSON.stringify(endpoint)})`,
        );
    }

    return url;
};

/**
 * The bucket's S3 endpoint: `<account endpoint>/<bucket>/`. The aws-light
 * provider resolves every key against it with `new URL(key, endpoint)`, so it
 * has to name the bucket and end in `/`; given the bare account endpoint, R2
 * would read each key's first segment as the bucket. An `endpoint` that names
 * the bucket already, as its last path segment or as a virtual-hosted
 * `<bucket>.<account>.r2…` host, is not given it twice.
 */
const bucketEndpoint = (options: R2UploadStorageOptions): string => {
    const url = options.endpoint === undefined ? new URL(`https://${options.accountId}.r2.cloudflarestorage.com`) : parseEndpoint(options.endpoint);
    const bucket = encodeURIComponent(options.bucket);
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const virtualHosted = options.endpoint !== undefined && url.hostname.startsWith(`${options.bucket.toLowerCase()}.`);

    if (!virtualHosted && segments.at(-1) !== bucket) {
        segments.push(bucket);
    }

    url.pathname = segments.length === 0 ? "/" : `/${segments.join("/")}/`;

    return url.href;
};

/**
 * Build an R2-backed storage provider for `createUploadHandler` using
 * `@visulima/storage`'s dependency-light `aws-light` provider (`aws4fetch`, no
 * AWS SDK). R2's S3 region alias is always `auto`.
 *
 * Requires an R2 **S3 API** token's Access Key ID / Secret Access Key — the
 * same credential shape `@lunora/storage`'s presigned-URL helpers take. In a
 * Worker the `aws-light` provider needs `nodejs_compat` (it imports
 * `node:stream`).
 *
 * The bucket is addressed path-style, `<endpoint>/<bucket>/<key>`.
 *
 * **Uploads of more than two parts fail upstream** (visulima/visulima#907): the
 * aws-light provider parses only the last `<Part>` of R2's ListParts answer, so
 * from the third chunk on it reads its offset wrong and refuses the chunk
 * (`409`). TUS uploads of one or two chunks complete. Prefer the R2 binding
 * provider (`./r2-binding-upload-storage`): it needs no S3 credentials and runs
 * under `wrangler dev` too. Chunked REST is refused over this provider (see
 * `createUploadHandler`).
 *
 * The provider takes no `@visulima/storage` limits of its own (its upload cap
 * is the 5 TB default), so `maxFileSize` / `maxFileSizeFor` on the handler are
 * the caps that apply.
 */
const createR2UploadStorage = (options: R2UploadStorageOptions & { secretAccessKey: string }): AwsLightStorage =>
    new AwsLightStorage({
        accessKeyId: options.accessKeyId,
        bucket: options.bucket,
        endpoint: bucketEndpoint(options),
        path: options.path ?? "/",
        region: "auto",
        secretAccessKey: options.secretAccessKey,
        ...(options.partSize === undefined ? {} : { partSize: options.partSize }),
    });

export type { R2UploadStorageOptions };
export { createR2UploadStorage };
