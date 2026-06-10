import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useT } from "../i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../internal";
import { ShardInput } from "../shard-input";
import type { ApiOperation } from "./openapi-model";
import { exampleForSchema } from "./schema-view";

/** Terminal/transient states of a single try-it invocation. */
type RunStatus = "error" | "idle" | "running" | "success";

/** Seed the args editor from the operation's argument schema (empty object when none). */
const seedArgs = (operation: ApiOperation): string => {
    const example = exampleForSchema(operation.argsSchema);

    return JSON.stringify(example ?? {}, undefined, 2);
};

interface TryItProps {
    readonly operation: ApiOperation;
}

/**
 * The live "Try it" console for one operation: edit the JSON arguments
 * (pre-seeded from the schema), optionally target a shard, and send the request
 * against the live {@link useCirrus} client. Cirrus RPC operations dispatch
 * through the kind-appropriate client method (`query` / `mutation` / `action`)
 * by their `functionPath`; the result or error renders below. A REST route
 * (no `functionPath`) falls back to a plain `fetch` of its path.
 *
 * This replaces Scalar's embedded "API Client" modal — no portal, no overlay,
 * just an in-panel form, so it can never intercept clicks or freeze the studio.
 */
const TryIt = ({ operation }: TryItProps): ReactElement => {
    const t = useT();
    const client = useCirrus();

    const [argsText, setArgsText] = useState<string>(() => seedArgs(operation));
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [response, setResponse] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);

    const onArgsChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        setArgsText(event.target.value);
    }, []);

    const send = useCallback(async (): Promise<void> => {
        let parsedArgs: unknown;

        try {
            parsedArgs = argsText.trim() === "" ? {} : JSON.parse(argsText);
        } catch (parseError) {
            setStatus("error");
            setResponse(undefined);
            setError(t("Invalid JSON args: {message}", { message: errorMessage(parseError) }));

            return;
        }

        setStatus("running");
        setError(null);

        try {
            let value: unknown;

            if (operation.functionPath === undefined) {
                // Plain REST route: best-effort fetch of the path with a JSON body.
                const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
                const fetchResponse = await fetch(operation.httpPath, {
                    body: hasBody ? JSON.stringify(parsedArgs) : undefined,
                    headers: hasBody ? { "content-type": "application/json" } : undefined,
                    method: operation.method,
                });

                value = await fetchResponse.json().catch(() => fetchResponse.text());
            } else {
                const reference = adminRef(operation.functionPath);
                const options = callOptions(shardKey);

                switch (operation.kind) {
                    case "action": {
                        value = await client.action(reference, parsedArgs, options);

                        break;
                    }
                    case "mutation": {
                        value = await client.mutation(reference, parsedArgs, options);

                        break;
                    }
                    default: {
                        value = await client.query(reference, parsedArgs, options);
                    }
                }
            }

            setResponse(value);
            setStatus("success");
        } catch (runError) {
            setResponse(undefined);
            setError(errorMessage(runError));
            setStatus("error");
        }
    }, [argsText, client, operation, shardKey, t]);

    const onSend = useCallback((): void => {
        fireAndForget(send());
    }, [send]);

    const responseText = useMemo(() => (response === undefined ? "" : JSON.stringify(response, undefined, 2)), [response]);

    return (
        <div className="flex flex-col gap-3" data-testid="api-try-it">
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

            <div className="flex items-center gap-3">
                <Button data-testid="api-try-send" disabled={status === "running"} onClick={onSend} type="button">
                    {status === "running" ? t("Sending…") : t("Send")}
                </Button>
                {status === "success" && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("200 OK")}</span>}
                {status === "error" && <span className="text-xs text-destructive">{t("Request failed")}</span>}
            </div>

            {status === "error" && error !== null && (
                <pre className="overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive" data-testid="api-try-error">
                    {error}
                </pre>
            )}

            {status === "success" && (
                <pre className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs" data-testid="api-try-response">
                    {responseText}
                </pre>
            )}
        </div>
    );
};

export default TryIt;
