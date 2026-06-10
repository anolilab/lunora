import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import { Button } from "../components/ui/button";
import { useT } from "../i18n-context";
import { fireAndForget } from "../internal";
import { useOperationRun } from "./run-context";

/** Copy `text` to the clipboard when available; a no-op under SSR/tests without one. */
const copyToClipboard = (text: string): void => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard, guarded by the "navigator" check
    const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

    if (clipboard !== undefined) {
        fireAndForget(clipboard.writeText(text));
    }
};

/**
 * The right-rail response panel: the live result of the last "try it" run for
 * the selected operation, with a colour-coded status pill, the round-trip
 * duration, and a copy button. Reads the shared {@link useOperationRun} state,
 * so it updates the moment the request console fires. Idle until the first send.
 */
const ResponsePanel = (): ReactElement => {
    const t = useT();
    const { durationMs, error, response, status } = useOperationRun();

    const body = useMemo(() => {
        if (status === "error") {
            return error ?? "";
        }

        return response === undefined ? "" : JSON.stringify(response, undefined, 2);
    }, [status, error, response]);

    const onCopy = useCallback((): void => {
        copyToClipboard(body);
    }, [body]);

    const ok = status === "success";
    const failed = status === "error";

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-sidebar/50" data-testid="api-response-panel">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Response")}</span>
                    {ok && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-600 dark:text-emerald-400" data-testid="api-response-status">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            {t("200 OK")}
                        </span>
                    )}
                    {failed && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-red-600 dark:text-red-400" data-testid="api-response-status">
                            <span className="size-1.5 rounded-full bg-red-500" />
                            {t("Error")}
                        </span>
                    )}
                    {durationMs !== null && (ok || failed) && <span className="font-mono text-[10px] text-muted-foreground">{t("{ms} ms", { ms: durationMs })}</span>}
                </div>
                {(ok || failed) && (
                    <Button aria-label={t("Copy")} data-testid="api-response-copy" onClick={onCopy} size="icon-xs" type="button" variant="ghost">
                        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                    </Button>
                )}
            </div>

            {status === "idle" || status === "running" ? (
                <p className="px-3 pb-3 text-xs text-muted-foreground" data-testid="api-response-idle">
                    {status === "running" ? t("Sending…") : t("Send a request to see the response.")}
                </p>
            ) : (
                <pre
                    className={`max-h-[28rem] overflow-auto px-3 pb-3 font-mono text-xs ${failed ? "text-destructive" : ""}`}
                    data-testid={failed ? "api-response-error" : "api-response-body"}
                >
                    {body}
                </pre>
            )}
        </div>
    );
};

export default ResponsePanel;
