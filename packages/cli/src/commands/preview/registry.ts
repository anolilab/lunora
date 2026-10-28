/**
 * The account side of a preview: the record of what each preview owns, and the D1 / KV / R2 calls that make
 * and remove those resources.
 *
 * The record lives in the account, not the checkout, because the job that deletes a preview (a closed pull
 * request) runs on a fresh CI runner that never saw the deploy. It is a KV namespace of its own, one key per
 * preview, written right after each resource is created, so a deploy that fails halfway still leaves
 * everything it made on record. Deletion acts only on what a record lists.
 */
import type { CloudflareRestOutcome } from "../../../../../shared/cloudflare-rest";
import type { PreviewResourceKind } from "./plan";

type Request = (path: string, init?: RequestInit) => Promise<CloudflareRestOutcome>;

/** The KV namespace holding the records. Never deleted by `preview delete`: it outlives every preview. */
const REGISTRY_TITLE = "lunora-preview-registry";

/** Pages after which a listing is given up on. */
const MAX_PAGES = 50;

interface RecordedResource {
    binding: string;
    /** The id the binding uses: a D1 uuid, a KV namespace id, an R2 bucket name. */
    id: string;
    kind: PreviewResourceKind;
    name: string;
}

interface PreviewRecord {
    createdAt: string;
    environment: string;
    /** The preview's slug. */
    name: string;
    production: string;
    resources: RecordedResource[];
    updatedAt: string;
    url?: string;
    version: 1;
    worker: string;
}

/** What Cloudflare said went wrong, from its error envelope, without echoing the request. */
const describeFailure = (outcome: { status: number; text: string }): string => {
    try {
        const { errors } = JSON.parse(outcome.text) as { errors?: { message?: unknown }[] };
        const reasons = (errors ?? []).flatMap((error) => (typeof error.message === "string" ? [error.message] : [])).join("; ");

        return reasons === "" ? `HTTP ${String(outcome.status)}` : `HTTP ${String(outcome.status)}: ${reasons}`;
    } catch {
        return `HTTP ${String(outcome.status)}`;
    }
};

const expectOk = (outcome: CloudflareRestOutcome, what: string): Record<string, unknown> => {
    if (!outcome.ok) {
        throw new Error(`${what} failed (${describeFailure(outcome)})`);
    }

    return outcome.body;
};

const resultObject = (body: Record<string, unknown>): Record<string, unknown> =>
    typeof body.result === "object" && body.result !== null ? (body.result as Record<string, unknown>) : {};

/** The first listed entry `match` accepts, following the listing's pages. Throws when absence cannot be shown. */
const findListed = async (
    request: Request,
    path: string,
    what: string,
    match: (entry: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> => {
    const separator = path.includes("?") ? "&" : "?";

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page is only asked for if the previous one didn't have it
        const body = expectOk(await request(`${path}${separator}per_page=100&page=${String(page)}`), `listing ${what}`);

        // A reply that isn't a list can't show the name is absent, and absence is what permits a create.
        if (!Array.isArray(body.result)) {
            throw new TypeError(`the listing of ${what} had no result list`);
        }

        const found = (body.result as Record<string, unknown>[]).find((entry) => match(entry));
        const info = (typeof body.result_info === "object" && body.result_info !== null ? body.result_info : {}) as { total_pages?: unknown };

        if (found !== undefined || typeof info.total_pages !== "number" || page >= info.total_pages) {
            return found;
        }
    }

    throw new Error(`the listing of ${what} has more than ${String(MAX_PAGES)} pages`);
};

const findKvNamespace = async (request: Request, title: string): Promise<string | undefined> => {
    const found = await findListed(request, "/storage/kv/namespaces", "KV namespaces", (entry) => entry.title === title);

    return typeof found?.id === "string" ? found.id : undefined;
};

const createKvNamespace = async (request: Request, title: string): Promise<string> => {
    const { id } = resultObject(
        expectOk(await request("/storage/kv/namespaces", { body: JSON.stringify({ title }), method: "POST" }), `creating KV namespace "${title}"`),
    );

    if (typeof id !== "string") {
        throw new TypeError(`creating KV namespace "${title}" returned no id`);
    }

    return id;
};

/** The registry namespace's id; created only when `create` is set (a deploy), so list and delete never make one. */
const registryNamespace = async (request: Request, create: boolean): Promise<string | undefined> => {
    const existing = await findKvNamespace(request, REGISTRY_TITLE);

    return existing ?? (create ? createKvNamespace(request, REGISTRY_TITLE) : undefined);
};

const recordKey = (production: string, slug: string): string => `${production}/${slug}`;

const valuePath = (namespace: string, key: string): string => `/storage/kv/namespaces/${encodeURIComponent(namespace)}/values/${encodeURIComponent(key)}`;

const isRecord = (value: unknown): value is PreviewRecord => {
    const candidate = value as Partial<PreviewRecord> | null;

    return (
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.version === 1 &&
        typeof candidate.worker === "string" &&
        typeof candidate.production === "string" &&
        Array.isArray(candidate.resources)
    );
};

/** The record for one preview, or `undefined` when there is none. A value that is not a record is refused, not guessed at. */
const readRecord = async (request: Request, namespace: string, key: string): Promise<PreviewRecord | undefined> => {
    const outcome = await request(valuePath(namespace, key));

    if (!outcome.ok && outcome.status === 404) {
        return undefined;
    }

    // A KV value is returned raw, not in Cloudflare's envelope: the parsed body is the record itself.
    const body = expectOk(outcome, `reading the preview record "${key}"`);

    if (!isRecord(body)) {
        throw new TypeError(`the preview record "${key}" is not one this CLI wrote; refusing to act on it`);
    }

    return body;
};

const writeRecord = async (request: Request, namespace: string, record: PreviewRecord): Promise<void> => {
    expectOk(
        await request(valuePath(namespace, recordKey(record.production, record.name)), { body: JSON.stringify(record), method: "PUT" }),
        "writing the preview record",
    );
};

const deleteRecord = async (request: Request, namespace: string, record: PreviewRecord): Promise<void> => {
    expectOk(await request(valuePath(namespace, recordKey(record.production, record.name)), { method: "DELETE" }), "removing the preview record");
};

/** Every recorded preview of `production`. */
const listRecords = async (request: Request, namespace: string, production: string): Promise<PreviewRecord[]> => {
    const prefix = `${production}/`;
    const body = expectOk(
        await request(`/storage/kv/namespaces/${encodeURIComponent(namespace)}/keys?prefix=${encodeURIComponent(prefix)}`),
        "listing preview records",
    );
    const names = (Array.isArray(body.result) ? (body.result as { name?: unknown }[]) : []).flatMap((entry) =>
        typeof entry.name === "string" ? [entry.name] : [],
    );
    const records = await Promise.all(names.map(async (key) => readRecord(request, namespace, key)));

    return records.filter((record): record is PreviewRecord => record !== undefined);
};

/** The id of an existing resource of this kind and name, or `undefined` when there is none. */
const findResource = async (request: Request, kind: PreviewResourceKind, name: string): Promise<string | undefined> => {
    if (kind === "d1") {
        const found = await findListed(request, `/d1/database?name=${encodeURIComponent(name)}`, "D1 databases", (entry) => entry.name === name);

        return typeof found?.uuid === "string" ? found.uuid : undefined;
    }

    if (kind === "kv") {
        return findKvNamespace(request, name);
    }

    const outcome = await request(`/r2/buckets/${encodeURIComponent(name)}`);

    if (!outcome.ok && outcome.status === 404) {
        return undefined;
    }

    expectOk(outcome, `looking up R2 bucket "${name}"`);

    return name;
};

const createResource = async (request: Request, kind: PreviewResourceKind, name: string): Promise<string> => {
    if (kind === "kv") {
        return createKvNamespace(request, name);
    }

    if (kind === "r2") {
        expectOk(await request("/r2/buckets", { body: JSON.stringify({ name }), method: "POST" }), `creating R2 bucket "${name}"`);

        return name;
    }

    const { uuid } = resultObject(
        expectOk(await request("/d1/database", { body: JSON.stringify({ name }), method: "POST" }), `creating D1 database "${name}"`),
    );

    if (typeof uuid !== "string") {
        throw new TypeError(`creating D1 database "${name}" returned no id`);
    }

    return uuid;
};

const RESOURCE_PATHS: Record<PreviewResourceKind, (id: string) => string> = {
    d1: (id) => `/d1/database/${encodeURIComponent(id)}`,
    kv: (id) => `/storage/kv/namespaces/${encodeURIComponent(id)}`,
    r2: (id) => `/r2/buckets/${encodeURIComponent(id)}`,
};

/** Delete one recorded resource; one already gone counts as deleted. Throws with Cloudflare's reason otherwise. */
const deleteResource = async (request: Request, resource: RecordedResource): Promise<void> => {
    const outcome = await request(RESOURCE_PATHS[resource.kind](resource.id), { method: "DELETE" });

    if (outcome.ok || outcome.status === 404) {
        return;
    }

    // ponytail: R2 refuses to delete a bucket that still holds objects and the REST API cannot empty one; the
    // resource stays on record so a re-run retries it once the bucket is emptied.
    throw new Error(describeFailure(outcome));
};

/** Delete the preview Worker (and with it its Durable Objects). One already gone counts as deleted. */
const deleteWorker = async (request: Request, worker: string): Promise<void> => {
    const outcome = await request(`/workers/scripts/${encodeURIComponent(worker)}?force=true`, { method: "DELETE" });

    if (!outcome.ok && outcome.status !== 404) {
        throw new Error(describeFailure(outcome));
    }
};

/**
 * Whether a Worker of this name exists, and the preview marker var it was deployed with. Read from the script's
 * settings, whose `bindings` list a plain-text var with its `text`.
 */
const workerMarker = async (request: Request, worker: string, variable: string): Promise<{ exists: boolean; marker?: string }> => {
    const outcome = await request(`/workers/scripts/${encodeURIComponent(worker)}/settings`);

    if (!outcome.ok && outcome.status === 404) {
        return { exists: false };
    }

    const { bindings } = resultObject(expectOk(outcome, `reading Worker "${worker}"`));
    const marker = (Array.isArray(bindings) ? (bindings as { name?: unknown; text?: unknown; type?: unknown }[]) : []).find(
        (binding) => binding.type === "plain_text" && binding.name === variable,
    )?.text;

    return typeof marker === "string" ? { exists: true, marker } : { exists: true };
};

/** The account's workers.dev subdomain, which the preview's URL is on. */
const workersSubdomain = async (request: Request): Promise<string> => {
    const { subdomain } = resultObject(expectOk(await request("/workers/subdomain"), "reading the workers.dev subdomain"));

    if (typeof subdomain !== "string" || subdomain === "") {
        throw new TypeError("the account has no workers.dev subdomain; register one in the Cloudflare dashboard (Workers & Pages) first");
    }

    return subdomain;
};

export type { PreviewRecord, RecordedResource, Request };
export {
    createResource,
    deleteRecord,
    deleteResource,
    deleteWorker,
    findResource,
    listRecords,
    readRecord,
    recordKey,
    REGISTRY_TITLE,
    registryNamespace,
    workerMarker,
    workersSubdomain,
    writeRecord,
};
