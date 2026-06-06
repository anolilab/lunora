import type { FunctionReference } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";
import { useT } from "./i18n-context.js";
import { errorMessage, fireAndForget, formatTimestamp } from "./internal.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import type { FunctionDescriptor, FunctionKind, RunStatus } from "./types.js";

/** A single recorded invocation, kept purely in component state. */
interface RunHistoryEntry {
    /** The raw JSON args text used for the run. */
    argsText: string;
    /** Epoch-ms the run resolved. */
    at: number;
    /** Monotonic identifier, unique per mounted runner (stable React key). */
    id: number;
    kind: FunctionKind;
    path: string;
    /** Free-text shard key (empty for the root shard). */
    shardKey: string;
    status: "error" | "success";
}

/** How many recent runs to retain in the in-memory history. */
const MAX_HISTORY = 10;

interface FunctionRunnerProps {
    /**
     * Functions to expose. When omitted, the runner auto-discovers them via the
     * client's `listFunctions()` (the admin-gated `/_cirrus/admin/functions`
     * endpoint), so it works with no wiring when the worker is built with a
     * `functions` registry. Supply the list to override discovery.
     */
    readonly functions?: FunctionDescriptor[];
}

const formatResult = (value: unknown): string => {
    if (value === undefined) {
        return "undefined";
    }

    return JSON.stringify(value, null, 2);
};

/**
 * Interactive runner for the registered functions: pick one, edit its JSON
 * arguments, optionally target a shard, then invoke it against the live
 * {@link useCirrus} client and inspect the result or error.
 *
 * By default the function list is auto-discovered from the worker's
 * `/_cirrus/admin/functions` endpoint; pass an explicit `functions` array to
 * skip discovery (a query/mutation/action's `kind` is compile-time-only, so it
 * must be named).
 */
export const FunctionRunner = ({ functions: functionsProp }: FunctionRunnerProps = {}): ReactElement => {
    const t = useT();
    const client = useCirrus();

    const [discovered, setDiscovered] = useState<FunctionDescriptor[] | null>(null);
    const [discoverError, setDiscoverError] = useState<null | string>(null);

    // When the host supplies a list we use it verbatim; otherwise fall back to
    // whatever discovery has loaded so far (empty until the effect resolves).
    // Memoised so it stays referentially stable across renders — otherwise the
    // effects/memos below would re-run every render.
    const functions = useMemo(() => functionsProp ?? discovered ?? [], [functionsProp, discovered]);

    const [selectedPath, setSelectedPath] = useState<string>("");
    const [argsText, setArgsText] = useState<string>("{}");
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [result, setResult] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);
    const [runs, setRuns] = useState<RunHistoryEntry[]>([]);

    useEffect(() => {
        // The host supplied the list — nothing to discover, no cleanup needed.
        if (functionsProp !== undefined) {
            return undefined;
        }

        let cancelled = false;

        client
            .listFunctions()
            .then((list) => {
                if (!cancelled) {
                    setDiscovered(list);
                }

                return list;
            })
            .catch((error_: unknown) => {
                if (!cancelled) {
                    setDiscoverError(errorMessage(error_));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, functionsProp]);

    // The selection defaults to the first function until the user picks one.
    // Derived (not synced via an effect) so there's no extra render and the
    // value is always consistent with the current list.
    const effectivePath = selectedPath === "" ? (functions[0]?.path ?? "") : selectedPath;

    const selected = useMemo(() => functions.find((descriptor) => descriptor.path === effectivePath), [functions, effectivePath]);

    const run = useCallback(async (): Promise<void> => {
        if (!selected) {
            return;
        }

        let parsedArgs: unknown;

        try {
            parsedArgs = argsText.trim() === "" ? {} : JSON.parse(argsText);
        } catch (parseError) {
            setStatus("error");
            setResult(undefined);
            setError(t("Invalid JSON args: {message}", { message: (parseError as Error).message }));

            return;
        }

        const reference: FunctionReference = { __cirrusRef: selected.path };
        const options = shardKey.trim() === "" ? {} : { shardKey: shardKey.trim() };

        // Snapshot the inputs so a re-run from history replays exactly what ran.
        const record = (runStatus: "error" | "success"): void => {
            setRuns((previous) => {
                const entry: RunHistoryEntry = {
                    argsText,
                    at: Date.now(),
                    id: (previous[0]?.id ?? 0) + 1,
                    kind: selected.kind,
                    path: selected.path,
                    shardKey,
                    status: runStatus,
                };

                return [entry, ...previous].slice(0, MAX_HISTORY);
            });
        };

        setStatus("running");
        setError(null);

        try {
            let value: unknown;

            switch (selected.kind) {
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

            recordShard(shardKey);
            setResult(value);
            setStatus("success");
            record("success");
        } catch (runError) {
            setResult(undefined);
            setError((runError as Error).message);
            setStatus("error");
            record("error");
        }
    }, [argsText, client, selected, shardKey, t]);

    // Reload a recorded run's path + inputs into the form so it can be re-run.
    const loadRun = useCallback((entry: RunHistoryEntry): void => {
        setSelectedPath(entry.path);
        setArgsText(entry.argsText);
        setShardKey(entry.shardKey);
    }, []);

    const onSelectChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedPath(event.target.value);
    }, []);

    const onArgsChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
        setArgsText(event.target.value);
    }, []);

    const runOnce = useCallback((): void => {
        fireAndForget(run());
    }, [run]);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-function-runner">
            {discoverError !== null && (
                <p className="text-sm text-destructive" data-testid="function-discover-error" role="alert">
                    {discoverError}
                </p>
            )}

            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="function-select">{t("Function")}</Label>
                    <select
                        aria-label={t("Function")}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="function-select"
                        id="function-select"
                        onChange={onSelectChange}
                        value={effectivePath}
                    >
                        {functions.map((descriptor) => (
                            <option key={descriptor.path} value={descriptor.path}>
                                {descriptor.path} ({descriptor.kind})
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="args-input">{t("Arguments")}</Label>
                    <Textarea
                        aria-label={t("Arguments")}
                        className="font-mono text-xs"
                        data-testid="args-input"
                        id="args-input"
                        onChange={onArgsChange}
                        value={argsText}
                    />
                </div>

                <ShardInput onChange={setShardKey} testId="shard-input" value={shardKey} />

                <div className="flex flex-wrap items-center gap-2">
                    <Button data-testid="run-button" disabled={status === "running" || selected === undefined} onClick={runOnce} type="button">
                        {t("Run")}
                    </Button>
                    {selected !== undefined && <Badge variant="outline">{selected.kind}</Badge>}
                </div>
            </div>

            {status === "error" && error !== null && (
                <pre
                    className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-destructive"
                    data-testid="error"
                    role="alert"
                >
                    {error}
                </pre>
            )}

            {status === "success" && (
                <pre className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs" data-testid="result">
                    {formatResult(result)}
                </pre>
            )}

            {runs.length > 0 && (
                <ul className="flex flex-col rounded-md border border-border" data-testid="fn-history">
                    {runs.map((entry, index) => (
                        <li
                            className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                            data-testid="fn-history-row"
                            key={entry.id}
                        >
                            <span
                                className={entry.status === "success" ? "text-primary" : "text-destructive"}
                                data-testid={`fn-history-status-${index.toString()}`}
                            >
                                {entry.status === "success" ? "✓" : "✗"}
                            </span>{" "}
                            <span className="font-mono text-xs">
                                {entry.path} ({entry.kind})
                            </span>{" "}
                            <time className="text-xs text-muted-foreground">{formatTimestamp(entry.at)}</time>{" "}
                            <Button
                                className="ml-auto"
                                data-testid={`fn-history-load-${index.toString()}`}
                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over the history entry; admin dev-tool render path
                                onClick={() => {
                                    loadRun(entry);
                                }}
                                size="xs"
                                type="button"
                                variant="ghost"
                            >
                                {t("Load")}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export type { FunctionRunnerProps };
