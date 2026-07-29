/* eslint-disable unicorn/prevent-abbreviations -- "API", "Fn", and "Docs" are the domain terms for this API-docs panel; the file name and default-export name are fixed by the studio's tab wiring. */
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import type { TableInfo } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, copyToClipboard } from "../../lib/internal";
import type { FunctionDescriptor, FunctionKind } from "../../lib/types";

interface ApiDocsPanelProps {
    /**
     * Registered functions to document. Mirrors the list the Functions tab's
     * runner and stats panels receive — a query/mutation/action's `kind` is
     * compile-time-only, so it must be named here. When omitted the panel still
     * renders (tables come from the admin RPC) and shows an empty functions list.
     */
    readonly functions?: FunctionDescriptor[];

    /** Shard key the table list is read from. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);

/** Which snippet flavour the right pane shows for a function. */
type SnippetTab = "cli" | "client" | "react";

const TAB_KEYS: ReadonlyArray<SnippetTab> = ["react", "client", "cli"];

/** Inputs every function snippet builder closes over — the split path plus its `kind`. */
interface SnippetInput {
    /** The file segment of the `file:function` path. */
    readonly file: string;
    /** The function-name segment of the `file:function` path. */
    readonly fn: string;
    readonly kind: FunctionKind;
}

/**
 * `@lunora/react` ships `useQuery`/`useMutation`/`useSubscription` but no
 * `useAction` — actions have no hook, so the React tab falls back to the client
 * snippet for them (and the panel notes why). Exposed so the panel and its tests
 * read the same fact; flip to `true` and add a `useAction` branch below if a hook
 * is ever added to the barrel.
 */
const REACT_HAS_ACTION_HOOK: boolean = false;

/** The client method each function kind is invoked through. */
const CLIENT_METHOD: Record<FunctionKind, string> = {
    action: "action",
    mutation: "mutation",
    query: "query",
};

/**
 * Split a `file:function` descriptor path into its two halves. A path with no
 * colon is treated as a bare function in an empty file so the builders still
 * produce a usable (if odd) snippet rather than throwing.
 */
const splitPath = (path: string): { file: string; fn: string } => {
    const index = path.indexOf(":");

    if (index === -1) {
        return { file: "", fn: path };
    }

    return { file: path.slice(0, index), fn: path.slice(index + 1) };
};

/** Browser-SDK usage for a function: a single awaited call through the typed `client`. */
const buildClientSnippet = ({ file, fn, kind }: SnippetInput): string => `await client.${CLIENT_METHOD[kind]}(api.${file}.${fn}, { /* args */ });`;

/**
 * React-hook usage for a function. Queries read with `useQuery`; mutations bind
 * a callable with `useMutation`. Actions have no hook, so they fall back to the
 * client snippet.
 */
const buildReactSnippet = (input: SnippetInput): string => {
    const reference = `api.${input.file}.${input.fn}`;

    switch (input.kind) {
        case "action": {
            return buildClientSnippet(input);
        }
        case "mutation": {
            return `const ${input.fn} = useMutation(${reference});`;
        }
        default: {
            return `const data = useQuery(${reference}, { /* args */ });`;
        }
    }
};

/** CLI usage for a function. */
const buildCliSnippet = ({ file, fn }: SnippetInput): string => `lunora run ${file}:${fn} --args '{ }'`;

/** The typed data-model usage for one table: query/insert plus the generated row/id types. */
const buildTableSnippet = (table: string): string =>
    [
        `// Read rows`,
        `const rows = await ctx.db.query("${table}").collect();`,
        ``,
        `// Insert a row`,
        `const id = await ctx.db.insert("${table}", { /* fields */ });`,
        ``,
        `// Generated types`,
        `type Row = Doc<"${table}">;`,
        `type RowId = Id<"${table}">;`,
    ].join("\n");

/** Resolve the snippet text for the active tab. */
const snippetForTab = (tab: SnippetTab, input: SnippetInput): string => {
    switch (tab) {
        case "cli": {
            return buildCliSnippet(input);
        }
        case "client": {
            return buildClientSnippet(input);
        }
        default: {
            return buildReactSnippet(input);
        }
    }
};

/** A resource selected in the left rail: a registered function, or a table. */
type Selection = { kind: "fn"; path: string } | { kind: "table"; name: string };

interface SnippetBlockProps {
    readonly code: string;
    readonly label: string;
    readonly testId: string;
}

/** A labelled `pre` with a Copy button — the shared shape for every snippet block. */
const SnippetBlock = ({ code, label, testId }: SnippetBlockProps): ReactElement => {
    const t = useT();

    const onCopy = (): void => {
        copyToClipboard(code);
    };

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                <Button data-testid={`${testId}-copy`} onClick={onCopy} size="xs" type="button" variant="ghost">
                    {t("Copy")}
                </Button>
            </div>
            <pre className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs" data-testid={testId}>
                {code}
            </pre>
        </div>
    );
};

interface FunctionDocProps {
    readonly file: string;
    readonly fn: string;
    readonly kind: FunctionKind;
}

/**
 * Right-pane body for a selected function: React / Client / CLI snippet tabs.
 * Mounted with a `key` of the function path so a new selection remounts it —
 * that resets the active tab to React without a state-syncing effect.
 */
const FunctionDoc = ({ file, fn, kind }: FunctionDocProps): ReactElement => {
    const t = useT();
    const [tab, setTab] = useState<SnippetTab>("react");

    const input = { file, fn, kind };
    const tabLabel = { cli: t("CLI"), client: t("Client"), react: t("React") };

    const selectTab = (event: React.MouseEvent<HTMLButtonElement>): void => {
        setTab(event.currentTarget.dataset.tab as SnippetTab);
    };

    const code = snippetForTab(tab, input);
    const actionFellBack = kind === "action" && tab === "react" && !REACT_HAS_ACTION_HOOK;

    return (
        <div className="flex flex-col gap-3" data-testid="api-fn-doc">
            <div>
                <h2 className="font-mono text-sm font-semibold text-foreground" data-testid="api-fn-title">
                    {`api.${file}.${fn}`}
                </h2>
                <p className="text-xs text-muted-foreground">{t("Call this {kind} from your app.", { kind })}</p>
            </div>

            <div aria-label={t("Snippet flavour")} className="flex gap-1.5" data-testid="api-tabs" role="tablist">
                {TAB_KEYS.map((key) => (
                    <Button
                        aria-selected={tab === key}
                        data-tab={key}
                        data-testid={`api-tab-${key}`}
                        key={key}
                        onClick={selectTab}
                        role="tab"
                        size="xs"
                        type="button"
                        variant={tab === key ? "default" : "outline"}
                    >
                        {tabLabel[key]}
                    </Button>
                ))}
            </div>

            <SnippetBlock code={code} label={tabLabel[tab]} testId={`api-snippet-${tab}`} />

            {actionFellBack && (
                <p className="text-xs text-muted-foreground" data-testid="api-action-note">
                    {t("Actions have no React hook — call them through the client.")}
                </p>
            )}
        </div>
    );
};

/** Right-pane body for a selected table: the typed data-model usage. */
const TableDoc = ({ name }: { readonly name: string }): ReactElement => {
    const t = useT();
    const code = buildTableSnippet(name);

    return (
        <div className="flex flex-col gap-3" data-testid="api-table-doc">
            <div>
                <h2 className="font-mono text-sm font-semibold text-foreground" data-testid="api-table-title">
                    {name}
                </h2>
                <p className="text-xs text-muted-foreground">{t("Read and write this table through the typed data model.")}</p>
            </div>
            <SnippetBlock code={code} label={t("Data model")} testId="api-snippet-table" />
        </div>
    );
};

interface RailButtonProps {
    readonly active: boolean;
    readonly label: string;
    readonly onSelect: (value: string) => void;
    readonly testId: string;
    /** The opaque identifier handed back to `onSelect` (a function path or table name). */
    readonly value: string;
}

/** One left-rail entry. Extracted so each row owns a stable click handler (react-perf). */
const RailButton = ({ active, label, onSelect, testId, value }: RailButtonProps): ReactElement => {
    const onClick = (): void => {
        onSelect(value);
    };

    return (
        <button
            aria-current={active ? "page" : undefined}
            className="w-full truncate rounded-md px-2 py-1 text-start font-mono text-xs text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
            data-testid={testId}
            onClick={onClick}
            type="button"
        >
            {label}
        </button>
    );
};

interface FunctionGroup {
    readonly file: string;
    readonly items: ReadonlyArray<{ fn: string; kind: FunctionKind; path: string }>;
}

/**
 * Per-resource "how to call this from your app" browser, generated from the
 * registered functions and tables the studio already has — no new endpoints.
 * The left rail lists functions grouped by file plus a Tables section; the right
 * pane shows copy-paste snippets (React / Client / CLI for functions; the typed
 * data-model usage for tables).
 *
 * Args are a placeholder: the real argument shape lives in the codegen'd `api`
 * types this browser never loads, the same way Supabase's usage snippets show
 * placeholders.
 */
/** Group function descriptors by their file segment, files sorted, functions sorted within each file — a stable, scannable rail. */
const groupByFile = (functionList: ReadonlyArray<FunctionDescriptor>): ReadonlyArray<FunctionGroup> => {
    const byFile = new Map<string, { fn: string; kind: FunctionKind; path: string }[]>();

    for (const descriptor of functionList) {
        const { file, fn } = splitPath(descriptor.path);
        const bucket = byFile.get(file) ?? [];

        bucket.push({ fn, kind: descriptor.kind, path: descriptor.path });
        byFile.set(file, bucket);
    }

    return [...byFile.entries()]
        .map(([file, items]) => {
            return { file, items: items.toSorted((a, b) => a.fn.localeCompare(b.fn)) };
        })
        .toSorted((a, b) => a.file.localeCompare(b.file));
};

const ApiDocsPanel = ({ functions, initialShardKey }: ApiDocsPanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [selected, setSelected] = useState<Selection | null>(null);

    useEffect(() => {
        let cancelled = false;

        client
            .query(LIST_TABLES, {}, callOptions(initialShardKey ?? ""))
            .then((result) => {
                if (!cancelled) {
                    setTables(result as TableInfo[]);
                }

                return result;
            })
            .catch(() => {
                // Tables are best-effort here; the functions side still works, so
                // a failed list simply renders an empty Tables section.
                if (!cancelled) {
                    setTables([]);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, initialShardKey]);

    const functionList = functions ?? [];

    // Group function descriptors by their file segment, files sorted, functions
    // sorted within each file — a stable, scannable rail.
    const grouped = groupByFile(functionList);

    const tableNames = (tables ?? []).map((table) => table.name).toSorted((a, b) => a.localeCompare(b));

    const selectFunction = (path: string): void => {
        setSelected({ kind: "fn", path });
    };

    const selectTable = (name: string): void => {
        setSelected({ kind: "table", name });
    };

    const selectedFunction = selected?.kind === "fn" ? functionList.find((descriptor) => descriptor.path === selected.path) : undefined;

    const hasResources = functionList.length > 0 || tableNames.length > 0;
    const selectedSplit = selectedFunction === undefined ? undefined : splitPath(selectedFunction.path);

    return (
        <div className="grid min-h-0 gap-6 md:grid-cols-[16rem_minmax(0,1fr)]" data-testid="lunora-api-docs">
            <nav aria-label={t("API resources")} className="flex flex-col gap-4 overflow-y-auto" data-testid="api-rail">
                {grouped.map((group) => (
                    <div className="flex flex-col gap-1" key={group.file}>
                        <span className="px-2 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{group.file || t("(root)")}</span>
                        {group.items.map((item) => (
                            <RailButton
                                active={selected?.kind === "fn" && selected.path === item.path}
                                key={item.path}
                                label={item.fn}
                                onSelect={selectFunction}
                                testId={`api-rail-fn-${item.path}`}
                                value={item.path}
                            />
                        ))}
                    </div>
                ))}

                {tableNames.length > 0 && (
                    <div className="flex flex-col gap-1">
                        <span className="px-2 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Tables")}</span>
                        {tableNames.map((name) => (
                            <RailButton
                                active={selected?.kind === "table" && selected.name === name}
                                key={name}
                                label={name}
                                onSelect={selectTable}
                                testId={`api-rail-table-${name}`}
                                value={name}
                            />
                        ))}
                    </div>
                )}

                {!hasResources && (
                    <p className="px-2 text-xs text-muted-foreground" data-testid="api-rail-empty">
                        {t("No functions or tables to document yet.")}
                    </p>
                )}
            </nav>

            <div className="min-w-0">
                {selected === null && (
                    <EmptyState
                        description={t("Select a function or table to see how to call it from your app.")}
                        testId="api-empty"
                        title={t("API usage snippets")}
                    />
                )}

                {selected?.kind === "fn" && selectedFunction !== undefined && selectedSplit !== undefined && (
                    <FunctionDoc file={selectedSplit.file} fn={selectedSplit.fn} key={selectedFunction.path} kind={selectedFunction.kind} />
                )}

                {selected?.kind === "fn" && selectedFunction === undefined && <EmptyState testId="api-empty" title={t("API usage snippets")} />}

                {selected?.kind === "table" && <TableDoc name={selected.name} />}
            </div>
        </div>
    );
};

export type { ApiDocsPanelProps };
export { buildClientSnippet, buildCliSnippet, buildReactSnippet, buildTableSnippet, REACT_HAS_ACTION_HOOK, splitPath };
export default ApiDocsPanel;
