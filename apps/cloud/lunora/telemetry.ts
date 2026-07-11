import { fingerprintError } from "@lunora/fingerprint";
import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, v } from "./_generated/server.js";
import { authorizeDeployKey } from "./authz";

/**
 * Telemetry ingest for the Cloud Observability pipeline (superlog model). The
 * tenant Worker's `otlpSink` and the container OTLP exporter POST OTLP to
 * `POST /v1/telemetry`; the router decodes it to normalized error events and
 * calls this deploy-key-authorized mutation, which fingerprints each event (via
 * `@lunora/fingerprint`) and folds it onto one `issues` row per (org, hash).
 * Container events additionally open/update an `incidents` row.
 *
 * Synchronous, no queue: fingerprinting is pure and the writes are a bounded set
 * of indexed D1 upserts, and the control-plane mutation is serialized — so the
 * cheap path is a direct insert/patch (mirrors `usage.ingest` / `logs.ingest`),
 * not a fan-out job. Raw span/log archival + metrics ride a fire-and-forget
 * side-channel in the router handler, never blocking or failing ingest.
 */

/** Batch cap per ingest call — the tenant sink flushes well below this. */
const MAX_EVENTS = 500;

/** A normalized error event, decoded from an OTLP error span by the router. */
const telemetryEvent = v.object({
    // The Lunora error code, when the span carried `error.type` (metadata only).
    code: v.optional(v.string()),
    // Container name, for `kind: "container"` events.
    container: v.optional(v.string()),
    // Function path (`messages:list`) or `container:<name>` — the fingerprint culprit.
    functionPath: v.string(),
    // Container DO instance id, when known.
    instance: v.optional(v.string()),
    kind: v.union(v.literal("error"), v.literal("container")),
    message: v.string(),
    // Event time in epoch ms (decoded from the span's end time).
    ts: v.number(),
});

interface IssueRow {
    _id: Id<"issues">;
    count: number;
    lastSeen: number;
}

interface IncidentRow {
    _id: Id<"incidents">;
    count: number;
    lastSeen: number;
}

/** A batch group: all events sharing one fingerprint hash, pre-aggregated. */
interface EventGroup {
    container?: string;
    count: number;
    culprit: string;
    hash: string;
    instance?: string;
    kind: "container" | "error";
    lastTs: number;
    sampleMessage: string;
    title: string;
}

/** Classify a container failure from its message (crash-loop is the default). */
const detectIncidentKind = (message: string): "crash_loop" | "error_spike" | "oom" => {
    const lowered = message.toLowerCase();

    return lowered.includes("oom") || lowered.includes("out of memory") || lowered.includes("exit 137") ? "oom" : "crash_loop";
};

/**
 * Ingest a batch of normalized error events (deploy-key authorized — the tenant
 * sink holds an org deploy key). Events are folded into per-hash groups first so
 * a repeated error in one batch is a single upsert (and never a duplicate insert
 * under the unique `(org, hash)` index).
 */
export const ingest = mutation
    .input({
        deployKey: v.string(),
        deploymentId: v.optional(v.id("deployments")),
        events: v.array(telemetryEvent),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args }): Promise<{ incidents: number; issues: number }> => {
        await authorizeDeployKey(context, args.organizationId, args.deployKey);

        if (args.events.length > MAX_EVENTS) {
            throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_EVENTS)} events)`);
        }

        const now = Date.now();
        const groups = new Map<string, EventGroup>();

        for (const event of args.events) {
            const fingerprint = fingerprintError({ code: event.code, functionPath: event.functionPath, message: event.message });
            const group = groups.get(fingerprint.hash);

            if (group) {
                group.count += 1;
                group.lastTs = Math.max(group.lastTs, event.ts);
                group.sampleMessage = event.message;
            } else {
                groups.set(fingerprint.hash, {
                    container: event.container,
                    count: 1,
                    culprit: fingerprint.culprit,
                    hash: fingerprint.hash,
                    instance: event.instance,
                    kind: event.kind,
                    lastTs: event.ts,
                    sampleMessage: event.message,
                    title: fingerprint.title,
                });
            }
        }

        let issues = 0;
        let incidents = 0;

        for (const group of groups.values()) {
            // eslint-disable-next-line no-await-in-loop -- bounded, pre-grouped batch; the global mutation is serialized
            const { page } = await context.db.issues.findMany({ where: { hash: group.hash, organizationId: args.organizationId } });
            const existing = (page as unknown as IssueRow[])[0];

            if (existing) {
                // eslint-disable-next-line no-await-in-loop -- see above
                await context.db.patch(existing._id, {
                    count: existing.count + group.count,
                    lastSeen: Math.max(existing.lastSeen, group.lastTs),
                    sampleMessage: group.sampleMessage,
                    updatedAt: now,
                });
            } else {
                // eslint-disable-next-line no-await-in-loop -- see above
                await context.db.insert("issues", {
                    count: group.count,
                    createdAt: now,
                    culprit: group.culprit,
                    deploymentId: args.deploymentId,
                    firstSeen: group.lastTs,
                    hash: group.hash,
                    lastSeen: group.lastTs,
                    organizationId: args.organizationId,
                    sampleMessage: group.sampleMessage,
                    status: "open",
                    title: group.title,
                    updatedAt: now,
                });
            }

            issues += 1;

            if (group.kind !== "container") {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const { page: incidentPage } = await context.db.incidents.findMany({ where: { hash: group.hash, organizationId: args.organizationId } });
            const existingIncident = (incidentPage as unknown as IncidentRow[])[0];

            if (existingIncident) {
                // eslint-disable-next-line no-await-in-loop -- see above
                await context.db.patch(existingIncident._id, {
                    count: existingIncident.count + group.count,
                    lastSeen: Math.max(existingIncident.lastSeen, group.lastTs),
                    updatedAt: now,
                });
            } else {
                // eslint-disable-next-line no-await-in-loop -- see above
                await context.db.insert("incidents", {
                    container: group.container,
                    count: group.count,
                    createdAt: now,
                    deploymentId: args.deploymentId,
                    hash: group.hash,
                    instance: group.instance,
                    kind: detectIncidentKind(group.sampleMessage),
                    lastSeen: group.lastTs,
                    openedAt: now,
                    organizationId: args.organizationId,
                    status: "open",
                    title: group.title,
                    updatedAt: now,
                });
            }

            incidents += 1;
        }

        return { incidents, issues };
    });
