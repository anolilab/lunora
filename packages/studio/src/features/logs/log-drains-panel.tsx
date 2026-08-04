import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_OBSERVABILITY_URL } from "../../lib/cf-links";
import { copyToClipboard, errorMessage, fireAndForget } from "../../lib/internal";

/** One guided Cloudflare log destination: an explainer plus a copyable setup snippet. */
interface DestinationCard {
    /** Translated one-line explainer. */
    readonly description: string;
    /** Stable id; also keys the copy button testid (`drain-copy-<id>`). */
    readonly id: string;
    /** A `wrangler.jsonc` / setup snippet the operator copies into their project. */
    readonly snippet: string;
    /** Translated card title. */
    readonly title: string;
}

/** Outcome of a client-side webhook test send. */
type WebhookResult = { kind: "error"; message: string } | { kind: "success"; latencyMs: number; status: number };

/** One destination card: title + explainer + a copyable setup snippet. Extracted so its copy handler is a stable `useCallback`. */
const DestinationRow = ({ destination }: { readonly destination: DestinationCard }): ReactElement => {
    const t = useT();
    const onCopy = (): void => {
        copyToClipboard(destination.snippet);
    };

    return (
        <Card className="py-0" data-testid="drain-card">
            <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h4 className="text-sm font-semibold">{destination.title}</h4>
                        <p className="text-sm text-muted-foreground">{destination.description}</p>
                    </div>
                    <Button data-testid={`drain-copy-${destination.id}`} onClick={onCopy} size="sm" variant="outline">
                        {t("Copy")}
                    </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{destination.snippet}</pre>
            </CardContent>
        </Card>
    );
};

/**
 * Read-only **Log Drains** / log-export guidance.
 *
 * Lunora deliberately does not implement durable log shipping — that is the
 * platform's job (see `LogBuffer` in `@lunora/do`). So this panel is a guided
 * setup view, not a writable drain config: it explains the Cloudflare-native
 * forwarding paths (Workers Logs / Logpush / Tail Workers), deep-links to the
 * Cloudflare observability dashboard, and offers a client-side webhook test so
 * an operator can POST a sample Lunora request-log envelope at a downstream
 * collector and confirm it is reachable. Nothing here is persisted server-side.
 */

export const LogDrainsPanel = (): ReactElement => {
    const t = useT();

    const destinations: DestinationCard[] = [
        {
            description: t("Stream every request log to R2, a SIEM, or a third-party log service."),
            id: "logpush",
            snippet: ["{", '  "logpush": true', "}"].join("\n"),
            title: t("Logpush"),
        },
        {
            description: t("Send logs programmatically to a Worker for custom capture and forwarding."),
            id: "tail-worker",
            snippet: ["{", '  "tail_consumers": [{ "service": "my-log-forwarder" }]', "}"].join("\n"),
            title: t("Tail Workers"),
        },
        {
            description: t("Retain and query recent request logs directly in Cloudflare's dashboard."),
            id: "workers-logs",
            snippet: ["{", '  "observability": { "enabled": true }', "}"].join("\n"),
            title: t("Workers Logs"),
        },
    ];

    const [webhookUrl, setWebhookUrl] = useState<string>("");
    const [sending, setSending] = useState<boolean>(false);
    const [result, setResult] = useState<WebhookResult | null>(null);

    const sendTest = async (): Promise<void> => {
        const url = webhookUrl.trim();

        if (url === "") {
            return;
        }

        const fetchFunction = "fetch" in globalThis ? globalThis.fetch : undefined;

        if (fetchFunction === undefined) {
            setResult({ kind: "error", message: t("fetch is unavailable in this environment.") });

            return;
        }

        const sampleEvent = {
            durationMs: 12,
            function: "messages:list",
            outcome: "ok",
            shard: "root",
            source: "lunora",
            tablesRead: ["messages"],
            tablesWritten: [],
            ts: new Date().toISOString(),
            type: "request",
        };

        setSending(true);
        setResult(null);
        const startedAt = performance.now();

        try {
            const response = await fetchFunction(url, {
                body: JSON.stringify(sampleEvent),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            setResult({ kind: "success", latencyMs: Math.round(performance.now() - startedAt), status: response.status });
        } catch (error) {
            setResult({ kind: "error", message: errorMessage(error) });
        }

        setSending(false);
    };

    const onSendTest = (): void => {
        fireAndForget(sendTest());
    };
    const onWebhookUrlChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setWebhookUrl(event.target.value);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="log-drains">
            <div className="flex flex-wrap items-center gap-3">
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="drain-cf-link"
                    href={CLOUDFLARE_OBSERVABILITY_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="drain-readonly-note">
                {t("Lunora does not ship logs itself — forwarding is handled by Cloudflare. Configure a destination below, then test your collector.")}
            </p>

            <section className="flex flex-col gap-3" data-testid="drain-destinations">
                <h3 className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Cloudflare destinations")}</h3>

                {destinations.map((destination) => (
                    <DestinationRow destination={destination} key={destination.id} />
                ))}
            </section>

            <Card className="py-0">
                <CardContent className="p-3">
                    <section data-testid="drain-webhook">
                        <h3 className="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Webhook test")}</h3>
                        <p className="mb-2 text-sm text-muted-foreground">
                            {t("POST a sample Lunora request-log envelope to your collector to confirm it is reachable.")}
                        </p>

                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                className="min-w-[20rem] flex-1"
                                data-testid="drain-webhook-url"
                                onChange={onWebhookUrlChange}
                                placeholder={t("https://example.com/logs")}
                                type="url"
                                value={webhookUrl}
                            />
                            <Button data-testid="drain-webhook-test" disabled={sending || webhookUrl.trim() === ""} onClick={onSendTest}>
                                {sending ? t("Sending…") : t("Send test event")}
                            </Button>
                        </div>

                        {result !== null && (
                            <p
                                className={result.kind === "success" ? "mt-2 text-sm text-muted-foreground" : "mt-2 text-sm text-destructive"}
                                data-testid="drain-webhook-result"
                                role={result.kind === "error" ? "alert" : undefined}
                            >
                                {result.kind === "success"
                                    ? t("Delivered — status {status} in {latency}ms", { latency: result.latencyMs, status: result.status })
                                    : t("Failed: {message}", { message: result.message })}
                            </p>
                        )}
                    </section>
                </CardContent>
            </Card>
        </div>
    );
};
