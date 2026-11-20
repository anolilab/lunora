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
import { isOptionalString, jsonError, nonEmptyString, rejected, requireContext } from "./shared";

/**
 * `POST /v1/telemetry` body — an OTLP `ExportTraceServiceRequest` (its
 * `resourceSpans`) plus the deploy-key/org fields that authenticate + route it.
 */
interface TelemetryBody extends OtlpTracePayload {
    deployKey?: unknown;
    deploymentId?: unknown;
    organizationId?: unknown;
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

    const deployKey = nonEmptyString(body?.deployKey);
    const organizationId = nonEmptyString(body?.organizationId);

    if (!body || !deployKey || !organizationId || !isOptionalString(body.deploymentId)) {
        return jsonError(400, "deployKey and organizationId are required strings");
    }

    // `telemetry.ingest` refuses more than 500 events outright; trim like the
    // observations, and archive only what was ingested so the two agree.
    const events = decodeTelemetryEvents(body).slice(0, 500);
    // Every span (not just the error spans `events` keeps) → observations for
    // Traces. Sliced to the mutation's per-call cap so an oversized batch trims
    // rather than rejecting the whole ingest (and losing the Issue fold with it).
    const observations = decodeObservations(body).slice(0, 1000);

    try {
        const result = await context.runMutation<{ alerts: AlertDelivery[]; incidents: number; issues: number }>(api.telemetry.ingest, {
            deployKey,
            deploymentId: body.deploymentId,
            events,
            observations,
            organizationId,
        });

        const store = createCloudflareTelemetryStore(environment);

        store.recordCounts({ incidents: result.incidents, issues: result.issues, organizationId });
        await store.archiveEvents(events, organizationId).catch(() => undefined);
        // Tier every span to the columnar archive (scales past D1's hot window).
        await store.archiveSpans(observations, organizationId).catch(() => undefined);

        // Deliver any alerts the ingest fired (best-effort), then stamp the sent ones
        // delivered. An "owners & admins" alert is left `firing` for the drain, which
        // can read the members and the auth plane its addresses come from — and so is
        // one whose send failed, so the drain retries it rather than it reading as sent.
        const inline = result.alerts.filter((alert) => !(alert.channel === "email" && alert.destination === ORG_ADMINS_DESTINATION));
        const sent = await Promise.all(
            inline.map(async (alert) =>
                deliverAlert(environment, alert).then(
                    () => alert.id,
                    () => undefined,
                ),
            ),
        );
        const delivered = sent.filter((id) => id !== undefined);

        if (delivered.length > 0) {
            // Alerts have already gone out, so a failure here must not fail the
            // ingest — but it must not be invisible either: unmarked alerts are
            // re-delivered on the next sweep, so a failure means duplicate pages.
            await context
                .runMutation(internal.alerts.markDelivered, {
                    ids: delivered,
                    organizationId,
                })
                .catch((error: unknown) => {
                    // eslint-disable-next-line no-console -- delivered-but-unmarked alerts will re-fire; surface it
                    console.error("[alerts] markDelivered failed; alerts may be re-delivered", {
                        count: delivered.length,
                        error: error instanceof Error ? error.message : String(error),
                        organizationId,
                    });
                });
        }

        return Response.json({ alerts: result.alerts.length, incidents: result.incidents, issues: result.issues });
    } catch (error) {
        return rejected(error, "telemetry rejected");
    }
};
