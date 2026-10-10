/**
 * `POST /v1/deploy` — the HTTP adapter over the deploy core (`./release-core`):
 * authenticate the bearer deploy key, read and size-cap the JSON body, hold the
 * requested kind to the key's ceiling, then stream the release's frames as
 * NDJSON (one JSON object per line).
 */
import { DEFAULT_RUNTIME, isProjectRuntime, PROJECT_RUNTIMES } from "../project-runtime";
import type { DeployKind } from "../provision-contract";
import type { DeployHandlerDeps } from "./release-core";
import { startRelease } from "./release-core";

const json = (status: number, data: unknown): Response => Response.json(data, { headers: { "content-type": "application/json" }, status });

/** A Durable Object class name, as `manifest-parse` holds bindings' class names to. */
const CLASS_NAME = /^[A-Za-z_]\w{0,63}$/u;

/** `allowDeleteClasses`: absent, or at most 25 class names. */
const parseAllowDeleteClasses = (value: unknown): string[] | undefined | null => {
    if (value === undefined) {
        return undefined;
    }

    return Array.isArray(value) && value.length <= 25 && value.every((name) => typeof name === "string" && CLASS_NAME.test(name)) ? (value as string[]) : null;
};

interface DeployBody {
    /** Durable Object classes this release may delete, by name (`ReleaseRequest.allowDeleteClasses`). Untrusted until parsed. */
    allowDeleteClasses?: unknown;
    /** Static files behind the manifest's `assets` binding. Validated by `parsePayload` (`./manifest-parse`). */
    assets?: unknown;
    branch?: string;
    /** Base64-encoded prebuilt worker module (the app's Vite build output — never built here). */
    bundle?: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`) for the fan-out (§2.4). */
    cronSpecs?: string[];

    /**
     * `string`, not `DeployKind` — this is a parsed JSON body, so the declared
     * type is a claim about the wire, not a guarantee. Typing it as the union
     * would narrow the runtime guard below to `never` and quietly delete the only
     * thing standing between an arbitrary value and the deployment row.
     */
    kind?: string;
    /** The Worker's binding manifest. `unknown` because it is untrusted wire data; `parsePayload` validates it. */
    manifest?: unknown;
    projectId?: string;

    /**
     * What the bundle is: `lunora` (absent) or `worker`, a plain Cloudflare
     * Worker (`src/project-runtime.ts`). `unknown`, like `kind`, until checked.
     */
    runtime?: unknown;
    scriptName?: string;
}

/**
 * The whole request — bundle and assets travel base64 in one JSON body — is
 * capped before it is parsed. 50 MiB of assets is ~67 MiB base64, which leaves
 * room for the bundle; it is also Cloudflare's own request-size floor.
 */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the JSON body, refusing anything over {@link MAX_BODY_BYTES} — checked
 * against `content-length` first so an honest oversized upload is refused
 * unread, then against the bytes actually read, since a chunked body has no
 * declared length.
 */
const readBody = async (request: Request): Promise<{ body: DeployBody } | { response: Response }> => {
    const tooLarge = { response: json(413, { error: `request body exceeds ${String(MAX_BODY_BYTES)} bytes` }) };
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);

    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return tooLarge;
    }

    const bytes = await request.arrayBuffer();

    if (bytes.byteLength > MAX_BODY_BYTES) {
        return tooLarge;
    }

    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

        return isRecord(parsed) ? { body: parsed } : { response: json(400, { error: "request body must be a JSON object" }) };
    } catch {
        return { response: json(400, { error: "invalid JSON body" }) };
    }
};

/**
 * Deploy kinds ordered by privilege, least to most.
 *
 * `production` is the only one that can move a project's stable URL, so it sits
 * at the top; a key scoped to a lower rung may deploy at or below its own.
 */
const DEPLOY_RANK: Record<DeployKind, number> = { dev: 0, preview: 1, production: 2 };

/**
 * Whether a value is one of the three deploy kinds.
 *
 * `body.kind` arrives as an arbitrary string and flowed straight into the
 * deployment row and the dispatch-namespace name. Unvalidated it was worse than
 * untyped: an unknown kind ranked below every key scope, so it sailed through the
 * ceiling check below — and `activate` supersedes only SAME-KIND siblings, so a
 * deployment stamped `"prod"` would never supersede the real `production` release
 * and the real one would never supersede it. Two live releases, neither aware of
 * the other.
 */
const isDeployKind = (value: string): value is DeployKind => value === "dev" || value === "preview" || value === "production";

/** Whether a requested deploy kind is within the key's own scope. */
const deployKindWithin = (requested: DeployKind, allowed: DeployKind): boolean => DEPLOY_RANK[requested] <= DEPLOY_RANK[allowed];

const bearerKey = (request: Request): null | string => {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return null;
    }

    const key = rest.join(" ").trim();

    return key === "" ? null : key;
};

export const handleDeployRequest = async (request: Request, deps: DeployHandlerDeps): Promise<Response> => {
    const key = bearerKey(request);

    if (!key) {
        return json(401, { error: "missing bearer deploy key" });
    }

    const target = await deps.backend.verifyKey(key);

    if (!target) {
        return json(403, { error: "invalid or revoked deploy key" });
    }

    const read = await readBody(request);

    if ("response" in read) {
        return read.response;
    }

    const { body } = read;

    if (!body.projectId || !body.scriptName) {
        return json(400, { error: "projectId and scriptName are required" });
    }

    // Checked here rather than in the core so a malformed upload keeps the
    // error it always got first.
    if (!body.bundle) {
        return json(400, { error: "bundle is required (base64-encoded worker module)" });
    }

    const kind = body.kind ?? target.type;

    if (!isDeployKind(kind)) {
        return json(400, { error: `unknown deploy kind "${kind}" — expected dev, preview or production` });
    }

    // The key's `type` is a CEILING, not just a default.
    //
    // It was only ever used to default `kind`, so `body.kind` overrode it freely
    // and a key issued — and shown in the UI — as `dev` or `preview` could deploy
    // `production`: activating the project's stable-URL pointer and superseding the
    // live release. Operators hand out "preview-only" keys on the reasonable
    // assumption that the scope binds somewhere, and it did not.
    if (!deployKindWithin(kind, target.type)) {
        return json(403, {
            error: `this deploy key is scoped to ${target.type} and cannot deploy ${kind}. Issue a ${kind} key, or deploy with kind "${target.type}".`,
        });
    }

    // A plain Worker's release says so; `lunora cloud deploy` sends nothing and is a Lunora app.
    const runtime = body.runtime ?? DEFAULT_RUNTIME;

    if (!isProjectRuntime(runtime)) {
        return json(400, { error: `unknown runtime ${JSON.stringify(runtime).slice(0, 40)} — expected ${PROJECT_RUNTIMES.join(" or ")}` });
    }

    const allowDeleteClasses = parseAllowDeleteClasses(body.allowDeleteClasses);

    if (allowDeleteClasses === null) {
        return json(400, { error: "allowDeleteClasses must be at most 25 Durable Object class names" });
    }

    const started = await startRelease(
        {
            ...(allowDeleteClasses === undefined ? {} : { allowDeleteClasses }),
            assets: body.assets,
            branch: body.branch,
            bundle: body.bundle,
            cronSpecs: body.cronSpecs,
            kind,
            manifest: body.manifest,
            projectId: body.projectId,
            runtime,
            scriptName: body.scriptName,
        },
        { key, organizationId: target.organizationId },
        deps,
    );

    if ("error" in started) {
        return json(started.status, { error: started.error });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            await started.run((frame) => {
                controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            });
            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-accel-buffering": "no" }, status: 200 });
};
