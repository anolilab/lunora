import { api } from "../../../lunora/_generated/api";
import type { AlertDelivery } from "../../../lunora/telemetry";
import { deliverAlert } from "../../mail/notify";
import type { OtlpTracePayload } from "../../telemetry/otlp";
import { decodeObservations, decodeTelemetryEvents } from "../../telemetry/otlp";
import { ORG_ADMINS_DESTINATION } from "../../telemetry/recipients";
import { createCloudflareTelemetryStore } from "../../telemetry/store";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/**
 * `POST /v1/telemetry` body — an OTLP `ExportTraceServiceRequest` (its
 * `resourceSpans`) plus the deploy-key/org fields that authenticate + route it.
 */
interface TelemetryBody extends OtlpTracePayload {
    deployKey?: string;
    deploymentId?: string;
    organizationId?: string;
}

/**
 * `POST /v1/telemetry` — Cloud Observability ingest. Accepts OTLP-over-HTTP/JSON
 * from the tenant Worker `otlpSink` and the `@lunora/container` exporter, decodes
 * the error spans, and folds them into grouped issues/incidents (deploy-key
 * authorized inside `telemetry.ingest`). Metrics + raw archival are best-effort
 * side-effects that never block or fail the ingest.
 */
export const handleTelemetryRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = (await request.json().catch(() => null)) as TelemetryBody | null;

    if (!body?.deployKey || !body.organizationId) {
        return jsonError(400, "deployKey and organizationId are required");
    }

    const events = decodeTelemetryEvents(body);
    // Every span (not just the error spans `events` keeps) → observations for
    // Traces. Sliced to the mutation's per-call cap so an oversized batch trims
    // rather than rejecting the whole ingest (and losing the Issue fold with it).
    const observations = decodeObservations(body).slice(0, 1000);

    try {
        const result = await context.runMutation<{ alerts: AlertDelivery[]; incidents: number; issues: number }>(api.telemetry.ingest, {
            deployKey: body.deployKey,
            deploymentId: body.deploymentId,
            events,
            observations,
            organizationId: body.organizationId,
        });

        const store = createCloudflareTelemetryStore(environment);

        store.recordCounts({ incidents: result.incidents, issues: result.issues, organizationId: body.organizationId });
        await store.archiveEvents(events).catch(() => undefined);
        // Tier every span to the columnar archive (scales past D1's hot window).
        await store.archiveSpans(observations, body.organizationId ?? "").catch(() => undefined);

        // Deliver any alerts the ingest fired (best-effort), then stamp them delivered.
        // An "owners & admins" alert is left `firing` for the drain, which can read
        // the members and the auth plane its addresses come from.
        const inline = result.alerts.filter((alert) => !(alert.channel === "email" && alert.destination === ORG_ADMINS_DESTINATION));

        if (inline.length > 0) {
            await Promise.all(inline.map((alert) => deliverAlert(environment, alert).catch(() => undefined)));
            // Alerts have already gone out, so a failure here must not fail the
            // ingest — but it must not be invisible either: unmarked alerts are
            // re-delivered on the next sweep, and `markDelivered` is now rate-limited
            // (the `machine` bucket), so a 429 is a reachable cause of duplicate
            // pages rather than a theoretical one.
            await context
                .runMutation(api.alerts.markDelivered, {
                    deployKey: body.deployKey,
                    ids: inline.map((alert) => alert.id),
                    organizationId: body.organizationId,
                })
                .catch((error: unknown) => {
                    // eslint-disable-next-line no-console -- delivered-but-unmarked alerts will re-fire; surface it
                    console.error("[alerts] markDelivered failed; alerts may be re-delivered", {
                        count: inline.length,
                        error: error instanceof Error ? error.message : String(error),
                        organizationId: body.organizationId,
                    });
                });
        }

        return Response.json({ alerts: result.alerts.length, incidents: result.incidents, issues: result.issues });
    } catch (error) {
        return rejected(error, "telemetry rejected");
    }
};
