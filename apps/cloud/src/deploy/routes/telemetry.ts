import { api } from "../../../lunora/_generated/api";
import { internal } from "../../../lunora/_generated/internal";
import type { AlertDelivery } from "../../../lunora/telemetry";
import { deliverAlert } from "../../mail/notify";
import type { OtlpTracePayload } from "../../telemetry/otlp";
import { decodeObservations, decodeTelemetryEvents } from "../../telemetry/otlp";
import { ORG_ADMINS_DESTINATION } from "../../telemetry/recipients";
import { createCloudflareTelemetryStore } from "../../telemetry/store";
import { OtlpBodyTooLargeError, readAllCapped } from "./otlp";
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
 * The body as JSON, or `null` when it is not JSON. Drained under the OTLP routes'
 * byte cap because it is read before the deploy key is checked: an unbounded
 * `request.json()` let any caller make the isolate buffer an arbitrary body.
 * @throws {OtlpBodyTooLargeError} past the cap.
 */
const readTelemetryBody = async (request: Request): Promise<TelemetryBody | null> => {
    const bytes = await readAllCapped(request.body);

    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as TelemetryBody | null;
    } catch {
        return null;
    }
};

/**
 * `POST /v1/telemetry` — Cloud Observability ingest. Accepts OTLP-over-HTTP/JSON
 * from the tenant Worker `otlpSink` and the `@lunora/container` exporter, decodes
 * the error spans, and folds them into grouped issues/incidents (deploy-key
 * authorized inside `telemetry.ingest`). Metrics + raw archival are best-effort
 * side-effects that never block or fail the ingest.
 */
export const handleTelemetryRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    let body: TelemetryBody | null;

    try {
        body = await readTelemetryBody(request);
    } catch (error) {
        return error instanceof OtlpBodyTooLargeError ? jsonError(413, error.message) : jsonError(400, "unreadable request body");
    }

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
            // re-delivered on the next sweep, so a failure means duplicate pages.
            await context
                .runMutation(internal.alerts.markDelivered, {
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
