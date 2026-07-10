import type { FunctionReference } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, dispatchByKind, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import type { FunctionDescriptor, FunctionKind, RunStatus } from "../../lib/types";
import { argumentsTemplate, formatSignature } from "./function-signature";

/**
 * The admin RPC that executes a target function under a forged identity. Routed
 * through `client.query` like every other admin RPC (the DO intercepts it by
 * `functionPath` regardless of method) and gated server-side by the admin
 * bearer; the studio only surfaces it behind the {@link FunctionRunnerProps.runAsIdentity}
 * dev gate.
 */
const RUN_AS = adminRef(ADMIN_FUNCTIONS.runAs);

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
     * client's `listFunctions()` (the admin-gated `/_lunora/admin/functions`
     * endpoint), so it works with no wiring when the worker is built with a
     * `functions` registry. Supply the list to override discovery.
     */
    readonly functions?: FunctionDescriptor[];

    /**
     * Expose the "Run as identity" control — execute the selected function AS a
     * chosen authenticated user so an operator can test auth + RLS behavior.
     * Security-sensitive: the run is forwarded over the admin-gated
     * `__lunora_admin__:runAs` RPC, which forges the per-request identity. The
     * host sets this only on a trusted loopback-dev gate (the `Studio` component's
     * `runAsIdentity` prop); off by default, the runner always runs with the
     * caller's own (admin) identity.
     */
    readonly runAsIdentity?: boolean;
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
 * {@link useLunora} client and inspect the result or error.
 *
 * By default the function list is auto-discovered from the worker's
 * `/_lunora/admin/functions` endpoint; pass an explicit `functions` array to
 * skip discovery (a query/mutation/action's `kind` is compile-time-only, so it
 * must be named).
 */
export const FunctionRunner = ({ functions: functionsProp, runAsIdentity = false }: FunctionRunnerProps = {}): ReactElement => {
    const t = useT();
    const client = useLunora();

    const [discovered, setDiscovered] = useState<FunctionDescriptor[] | null>(null);
    const [discoverError, setDiscoverError] = useState<null | string>(null);

    // When the host supplies a list we use it verbatim; otherwise fall back to
    // whatever discovery has loaded so far (empty until the effect resolves).
    // Memoised so it stays referentially stable across renders — otherwise the
    // effects/memos below would re-run every render.
    const functions = functionsProp ?? discovered ?? [];

    const [selectedPath, setSelectedPath] = useState<string>("");
    const [argsText, setArgsText] = useState<string>("{}");
    const [shardKey, setShardKey] = useState<string>("");
    // The userId to run as; empty means "run with my own (admin) identity". Only
    // meaningful when `runAsIdentity` is enabled.
    const [runAsUserId, setRunAsUserId] = useState<string>("");
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

    const selected = functions.find((descriptor) => descriptor.path === effectivePath);

    const run = async (): Promise<void> => {
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

        const reference: FunctionReference = { __lunoraRef: selected.path };
        const options = shardKey.trim() === "" ? {} : { shardKey: shardKey.trim() };

        // "Run as identity": when the dev gate is on AND a userId is set, route
        // the call through the admin-gated `runAs` RPC, which forges the
        // per-request identity server-side so the function (and any RLS it uses)
        // observes that user. Empty userId (or the gate off) keeps the normal
        // path, running with the caller's own admin identity.
        const forgedUserId = runAsIdentity ? runAsUserId.trim() : "";

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
            // For a real identity, the admin `runAs` RPC dispatches the target on
            // the DO under the forged identity (kind-agnostic: every kind routes
            // through the DO's `handleRpc`, so a forged *action* runs inline), sent
            // over `client.query` like every admin RPC. An empty id runs normally.
            const value: unknown =
                forgedUserId === ""
                    ? await dispatchByKind(client, selected.kind, reference, parsedArgs, options)
                    : await client.query(RUN_AS, { args: parsedArgs as Record<string, unknown>, functionPath: selected.path, userId: forgedUserId }, options);

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
    };

    // Reload a recorded run's path + inputs into the form so it can be re-run.
    const loadRun = (entry: RunHistoryEntry): void => {
        setSelectedPath(entry.path);
        setArgsText(entry.argsText);
        setShardKey(entry.shardKey);
    };

    const onSelectChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedPath(event.target.value);
    };

    const onArgsChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
        setArgsText(event.target.value);
    };

    const onRunAsChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setRunAsUserId(event.target.value);
    };

    const runOnce = (): void => {
        fireAndForget(run());
    };

    // Replace the args box with a minimal JSON template (required args only)
    // derived from the selected function's signature.
    const prefillArgs = (): void => {
        setArgsText(argumentsTemplate(selected?.args));
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-function-runner">
            {discoverError !== null && (
                <p className="text-sm text-destructive" data-testid="function-discover-error" role="alert">
                    {discoverError}
                </p>
            )}

            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
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
                    {selected !== undefined && (
                        <p className="text-xs text-muted-foreground">
                            <span className="mr-1.5 font-medium">{t("Signature")}</span>
                            <code className="font-mono" data-testid="function-signature">
                                {formatSignature(selected.args)}
                            </code>
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="args-input">{t("Arguments")}</Label>
                        <Button data-testid="prefill-button" disabled={selected === undefined} onClick={prefillArgs} size="xs" type="button" variant="ghost">
                            {t("Prefill")}
                        </Button>
                    </div>
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

                {runAsIdentity && (
                    <div className="flex flex-col gap-1.5" data-testid="run-as-field">
                        <Label htmlFor="run-as-input">{t("Run as identity (userId)")}</Label>
                        <Input
                            aria-label={t("Run as identity (userId)")}
                            className="font-mono text-xs"
                            data-testid="run-as-input"
                            id="run-as-input"
                            onChange={onRunAsChange}
                            placeholder={t("Leave empty to run as admin")}
                            value={runAsUserId}
                        />
                        <p className="text-[11px] text-muted-foreground">
                            {t("Dev only: runs the function as this user so you can test auth and RLS. Forged over the admin gate.")}
                        </p>
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <Button data-testid="run-button" disabled={status === "running" || selected === undefined} onClick={runOnce} type="button">
                        {t("Run")}
                    </Button>
                    {selected !== undefined && <Badge variant="outline">{selected.kind}</Badge>}
                    {runAsIdentity && runAsUserId.trim() !== "" && (
                        <Badge data-testid="run-as-badge" variant="secondary">
                            {t("as {userId}", { userId: runAsUserId.trim() })}
                        </Badge>
                    )}
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
                <ul className="flex flex-col overflow-hidden rounded-xl border border-border" data-testid="fn-history">
                    {runs.map((entry, index) => (
                        <li
                            className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                            data-testid="fn-history-row"
                            key={entry.id}
                        >
                            <span
                                className={entry.status === "success" ? "text-success" : "text-destructive"}
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
