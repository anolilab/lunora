import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../../components/ui/button";
import type { TFunction } from "../../../i18n/i18n-context";
import { useT } from "../../../i18n/i18n-context";
import { copyToClipboard } from "../../../lib/internal";
import { cn } from "../../../lib/utils";
import JsonHighlight from "./json-highlight";
import type { ApiOperation, ApiResponse } from "./openapi-model";
import { useOperationRun } from "./run-context";
import { exampleForSchema } from "./schema-view";
import { statusDotClass, statusToneClass } from "./status-tone";

/** The synthetic tab id for the live "try it" result (kept distinct from any documented status). */
const LIVE_TAB = "__live__";

/** One selectable response tab: a documented example, or the live run. */
interface ResponseTab {
    /** Pretty-printed JSON body to render. */
    readonly body: string;
    /** Round-trip duration, live tab only. */
    readonly durationMs: null | number;
    /** Tab identity — a documented status string, or {@link LIVE_TAB}. */
    readonly id: string;
    /** Short tab label (the status, or "Live"). */
    readonly label: string;
    /** Whether this tab carries the live run result (vs. a documented example). */
    readonly live: boolean;
    /** Status string used for tone/dot colour. */
    readonly status: string;
}

/** A documented response's example body, derived from its JSON schema (empty when it has none). */
const exampleBody = (response: ApiResponse): string => (response.schema === undefined ? "" : JSON.stringify(exampleForSchema(response.schema), undefined, 2));

/** The live run's body — the error text on failure, the pretty-printed value on success. */
const liveBody = (error: null | string, response: unknown, failed: boolean): string => {
    if (failed) {
        return error ?? "";
    }

    return response === undefined ? "" : JSON.stringify(response, undefined, 2);
};

interface ResponseBodyProps {
    readonly active: ResponseTab | undefined;
    readonly running: boolean;
    readonly showError: boolean;
}

/** The body region: a "sending" notice, an idle/empty notice, or the selected tab's JSON. */
const ResponseBody = ({ active, running, showError }: ResponseBodyProps): ReactElement => {
    const t = useT();

    if (running) {
        return (
            <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="api-response-running">
                {t("Sending…")}
            </p>
        );
    }

    if (active === undefined || active.body === "") {
        return (
            <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="api-response-idle">
                {active?.live === true ? t("Send a request to see the response.") : t("No example for this response.")}
            </p>
        );
    }

    return (
        <pre
            className={cn("max-h-[28rem] overflow-auto px-3 py-3 font-mono text-xs", showError && "text-destructive")}
            data-testid={showError ? "api-response-error" : "api-response-body"}
        >
            {/* Error bodies are free-form text; documented examples and successful results are well-formed JSON. */}
            {showError ? active.body : <JsonHighlight code={active.body} />}
        </pre>
    );
};

/**
 * The right-rail response panel: documented response **examples** as status tabs
 * (one per `2xx` / `4xx` … the operation declares, each seeded from its schema)
 * with the live "try it" result folded in as a highlighted `Live` tab the moment
 * a request fires. Mirrors the target reference's right-hand response card — the
 * example sits beside the request sample before you ever send, then the real
 * round-trip (status pill + duration) takes over on send, while the documented
 * examples stay one click away for comparison.
 *
 * Reads the shared {@link useOperationRun} state, so it tracks the request
 * console without prop drilling; the provider is keyed on the operation, so
 * switching operations remounts this with freshly-seeded tabs.
 */
/** The documented responses, plus the live result as its own tab once the operation has been run. */
const buildTabs = (
    operation: ApiOperation,
    ran: boolean,
    error: null | string,
    response: unknown,
    failed: boolean,
    durationMs: null | number,
    t: TFunction,
): ResponseTab[] => {
    const documented = operation.responses.map((entry): ResponseTab => {
        return { body: exampleBody(entry), durationMs: null, id: entry.status, label: entry.status, live: false, status: entry.status };
    });

    if (!ran) {
        return documented;
    }

    // The live result reads as 2xx on success / "error" on failure so it picks up the same tone helpers.
    const live: ResponseTab = {
        body: liveBody(error, response, failed),
        durationMs,
        id: LIVE_TAB,
        label: t("Live"),
        live: true,
        status: failed ? "error" : "200",
    };

    return [live, ...documented];
};

const ResponsePanel = (): ReactElement => {
    const t = useT();
    const { durationMs, error, operation, response, status } = useOperationRun();

    const running = status === "running";
    const failed = status === "error";
    const ran = status === "success" || failed;

    // Documented example tabs, in declared order, plus the live tab once a run lands.
    const tabs = buildTabs(operation, ran, error, response, failed, durationMs, t);

    // Default selection: the live tab once a run has landed, otherwise a 2xx example (else the first tab).
    const defaultId = ran ? LIVE_TAB : (tabs.find((tab) => tab.status.startsWith("2"))?.id ?? tabs[0]?.id ?? "");
    // A manual pick overrides the default; it is dropped (back to null) whenever the operation remounts the panel.
    const [picked, setPicked] = useState<null | string>(null);

    const active = tabs.find((tab) => tab.id === (picked ?? defaultId)) ?? tabs[0];

    const onSelect = (event: React.MouseEvent<HTMLButtonElement>): void => {
        const { id } = event.currentTarget.dataset;

        if (id !== undefined) {
            setPicked(id);
        }
    };

    const onCopy = (): void => {
        if (active !== undefined) {
            copyToClipboard(active.body);
        }
    };

    const liveDurationMs = active?.live === true ? active.durationMs : null;
    const showError = active?.live === true && active.status === "error";

    return (
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card" data-testid="api-response-panel">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Response")}</span>
                <div className="flex items-center gap-2">
                    {liveDurationMs !== null && <span className="font-mono text-[10px] text-muted-foreground">{t("{ms} ms", { ms: liveDurationMs })}</span>}
                    {active !== undefined && active.body !== "" && (
                        <Button aria-label={t("Copy")} data-testid="api-response-copy" onClick={onCopy} size="icon-xs" type="button" variant="ghost">
                            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                        </Button>
                    )}
                </div>
            </div>

            {tabs.length > 0 && (
                <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5" role="tablist">
                    {tabs.map((tab) => {
                        const selected = tab.id === active?.id;

                        return (
                            <button
                                aria-selected={selected}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-xs transition-colors hover:text-foreground aria-selected:bg-muted aria-selected:font-medium",
                                    selected ? statusToneClass(tab.status) : "text-muted-foreground",
                                )}
                                data-id={tab.id}
                                data-testid={tab.live ? "api-response-tab-live" : `api-response-tab-${tab.status}`}
                                key={tab.id}
                                onClick={onSelect}
                                role="tab"
                                type="button"
                            >
                                <span className={`size-1.5 rounded-full ${statusDotClass(tab.status)}`} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            )}

            <ResponseBody active={active} running={running} showError={showError} />
        </div>
    );
};

export default ResponsePanel;
