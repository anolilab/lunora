import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";
import { useCallback } from "react";

import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useT } from "../i18n-context";
import { ShardInput } from "../shard-input";
import MethodBadge from "./method-badge";
import { useOperationRun } from "./run-context";

/**
 * The request console for the selected operation: a request bar (method/kind
 * chip · endpoint · Send) over a JSON arguments editor pre-seeded from the
 * schema, plus an optional shard target for RPC operations. It reads and drives
 * the shared {@link useOperationRun} state; the result renders in the right-rail
 * response panel. Pure in-panel form — no portal or overlay, so it can never
 * intercept clicks or freeze the studio the way Scalar's embedded client did.
 */
const TryIt = (): ReactElement => {
    const t = useT();
    const { argsText, operation, send, setArgsText, setShardKey, shardKey, status } = useOperationRun();

    const onArgsChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
            setArgsText(event.target.value);
        },
        [setArgsText],
    );

    const running = status === "running";

    return (
        <div className="overflow-hidden rounded-lg border border-border bg-sidebar/40" data-testid="api-try-it">
            {/* Request bar — endpoint + Send, mirroring the target's "Server URL … Send" header. */}
            <div className="flex items-center gap-2 border-b border-border bg-sidebar/60 px-3 py-2">
                <MethodBadge kind={operation.kind} method={operation.method} testId="api-try-method" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{operation.functionPath ?? operation.httpPath}</code>
                <Button data-testid="api-try-send" disabled={running} onClick={send} size="sm" type="button">
                    <HugeiconsIcon className={running ? "animate-pulse" : undefined} icon={SentIcon} strokeWidth={2} />
                    {running ? t("Sending…") : t("Send")}
                </Button>
            </div>

            <div className="flex flex-col gap-3 p-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="api-try-args">{t("Arguments (JSON)")}</Label>
                    <Textarea
                        className="font-mono text-xs"
                        data-testid="api-try-args"
                        id="api-try-args"
                        onChange={onArgsChange}
                        rows={Math.min(12, Math.max(3, argsText.split("\n").length))}
                        spellCheck={false}
                        value={argsText}
                    />
                </div>

                {operation.functionPath !== undefined && (
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="shard-input">{t("Shard key (optional)")}</Label>
                        <ShardInput onChange={setShardKey} testId="shard-input" value={shardKey} />
                    </div>
                )}
            </div>
        </div>
    );
};

export default TryIt;
