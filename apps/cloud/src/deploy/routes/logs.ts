import { api } from "../../../lunora/_generated/api";
import { internal } from "../../../lunora/_generated/internal";
import { constantTimeEqual } from "../../security/constant-time-equal";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** One line in a {@link LogsBody} batch — the framework's `type:"log"` event minus the transport keys (`logs.ingest` validates it). */
interface LogsLine {
    createdAt?: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level?: "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";
    message?: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

interface LogsBody {
    deployKey?: string;
    lines?: LogsLine[];
    organizationId?: string;
    scriptName?: string;
}

/**
 * `POST /v1/logs/ingest` — tenant runtime log ingestion (GAPS.md B2). The
 * dispatch-namespace tail worker maps each tenant `ctx.log` console event onto a
 * batch and POSTs it here; deploy-key authorized inside the `logs.ingest`
 * mutation, which validates each line's full structured shape.
 */
export const handleLogsIngestRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = (await request.json().catch(() => null)) as LogsBody | null;

    if (!body?.deployKey || !body.organizationId || !body.scriptName || !Array.isArray(body.lines)) {
        return jsonError(400, "deployKey, organizationId, scriptName and lines are required");
    }

    try {
        const result = await context.runMutation<{ ingested: number }>(api.logs.ingest, {
            deployKey: body.deployKey,
            lines: body.lines,
            organizationId: body.organizationId,
            scriptName: body.scriptName,
        });

        return Response.json(result);
    } catch (error) {
        return rejected(error, "log ingestion rejected");
    }
};

/** One per-script batch in a {@link TailBody}. */
interface TailBatchBody {
    lines?: unknown[];
    scriptName?: string;
}

interface TailBody {
    batches?: TailBatchBody[];
}

/**
 * `POST /v1/logs/tail` — platform ingest for the dispatch-namespace tail worker
 * (`src/tail/worker.ts`). Unlike the deploy-key `POST /v1/logs/ingest`, this is
 * gated by the shared `LUNORA_TAIL_SECRET` (the tail worker holds one platform
 * secret, not per-org deploy keys) and resolves each batch's `scriptName` → org
 * via `internal.logs.orgForScript` before storing through
 * `internal.logs.ingestInternal`. Batches for an unknown script (a superseded
 * release the tail lags behind) are dropped, not errored; a batch whose ingest
 * throws is counted in `failed` and the rest of the flush still lands. The
 * tail worker splits a script's lines into batches the ingest accepts
 * (`src/tail/parse.ts`), and the ingest holds each organization to its ceiling
 * (`src/tail/ingest-budget.ts`).
 */
export const handleLogsTailRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const secret = environment.LUNORA_TAIL_SECRET;

    if (!secret) {
        return jsonError(503, "log tail ingest not configured");
    }

    const presented = request.headers.get("x-lunora-tail-secret");

    if (presented === null || !constantTimeEqual(presented, secret)) {
        return jsonError(403, "invalid tail secret");
    }

    const body = (await request.json().catch(() => null)) as null | TailBody;

    if (!body || !Array.isArray(body.batches)) {
        return jsonError(400, "batches are required");
    }

    let ingested = 0;
    let scripts = 0;
    let failed = 0;

    // One batch at a time, each on its own: a script whose ingest fails — over a
    // cap, or a store error — never costs another script (another org's) its lines.
    for (const batch of body.batches) {
        if (!batch.scriptName || !Array.isArray(batch.lines) || batch.lines.length === 0) {
            continue;
        }

        try {
            // Resolving the script belongs inside the try too: a failed lookup costs only this batch.
            // eslint-disable-next-line no-await-in-loop -- bounded per-flush script set; sequential keeps the resolver simple
            const resolved = await context.runQuery<{ organizationId: string } | null>(internal.logs.orgForScript, { scriptName: batch.scriptName });

            if (!resolved) {
                continue;
            }

            scripts += 1;

            // eslint-disable-next-line no-await-in-loop -- see above
            const result = await context.runMutation<{ ingested: number }>(internal.logs.ingestInternal, {
                lines: batch.lines,
                organizationId: resolved.organizationId,
                scriptName: batch.scriptName,
            });

            ingested += result.ingested;
        } catch {
            failed += 1;
        }
    }

    return Response.json({ failed, ingested, scripts });
};
