import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "../../../components/ui/input";
import { useT } from "../../../i18n/i18n-context";
import CodeSamples from "./code-samples";
import MethodBadge from "./method-badge";
import type { ApiModel, ApiTagGroup } from "./openapi-model";
import OperationView from "./operation-view";
import ResponsePanel from "./response-panel";
import { OperationRunProvider } from "./run-context";

/** Narrow the model's groups to operations whose summary/id matches `query` (empty groups dropped). */
const filterGroups = (groups: ApiTagGroup[], query: string): ApiTagGroup[] => {
    const needle = query.trim().toLowerCase();

    if (needle === "") {
        return groups;
    }

    // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over the API tag groups while filtering; the list is the spec's tag count and the walk is per keystroke on a small collection
    return groups
        .map((group): ApiTagGroup => {
            return {
                ...group,
                operations: group.operations.filter((operation) => `${operation.summary} ${operation.operationId}`.toLowerCase().includes(needle)),
            };
        })
        .filter((group) => group.operations.length > 0);
};

interface ReferenceViewProps {
    readonly model: ApiModel;
}

/**
 * The shared, spec-agnostic API reference UI: a three-column layout — a
 * filterable, tag-grouped operation sidebar; the selected operation's
 * documentation + request console; and a right rail pairing copy-paste request
 * samples with the live response. It renders any {@link ApiModel}, so both the
 * OpenAPI and OpenRPC panels drive the *same* UI through their parsers —
 * replacing the embedded Scalar reference (and the old bespoke OpenRPC viewer)
 * with one native, overlay-free surface that themes to the studio and ships no
 * extra bundle.
 */
const ReferenceView = ({ model }: ReferenceViewProps): ReactElement => {
    const t = useT();

    const firstKey = model.groups[0]?.operations[0]?.key ?? "";
    const [selectedKey, setSelectedKey] = useState<string>(firstKey);
    const [filter, setFilter] = useState<string>("");

    // The selection falls back to the first operation until the user picks one,
    // and self-heals if the spec reloads and the previous key is gone.
    const selected = model.operationByKey.get(selectedKey) ?? model.operationByKey.get(firstKey);
    const groups = filterGroups(model.groups, filter);

    const onSelect = (event: React.MouseEvent<HTMLButtonElement>): void => {
        const { key } = event.currentTarget.dataset;

        if (key !== undefined) {
            setSelectedKey(key);
        }
    };

    const onFilterChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.target.value);
    };

    const server = model.server ?? "";

    return (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)_22rem]" data-testid="api-reference">
            {/* Operation sidebar — a sticky filter over a pinned, self-scrolling nav. */}
            <nav aria-label={t("API operations")} className="flex min-h-0 flex-col overflow-y-auto border-r border-border" data-testid="api-reference-nav">
                <div className="sticky top-0 z-10 border-b border-border bg-sidebar p-2">
                    <div className="relative">
                        <HugeiconsIcon
                            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                            icon={Search01Icon}
                            strokeWidth={2}
                        />
                        <Input className="h-7 pl-7" data-testid="api-filter" onChange={onFilterChange} placeholder={t("Filter operations")} value={filter} />
                    </div>
                </div>

                <div className="flex flex-col gap-4 p-2">
                    {groups.map((group) => (
                        <div className="flex flex-col gap-1" key={group.name}>
                            <div className="flex items-center justify-between px-2">
                                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{group.name || t("(root)")}</span>
                                <span className="font-mono text-[10px] text-muted-foreground/70">{group.operations.length}</span>
                            </div>
                            {group.operations.map((operation) => {
                                const active = operation.key === selected?.key;

                                return (
                                    <button
                                        aria-current={active ? "page" : undefined}
                                        className="flex items-center justify-between gap-2 rounded-md border-l-2 border-transparent px-2 py-1 text-start text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:border-primary aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                                        data-key={operation.key}
                                        data-testid={`api-nav-${operation.operationId}`}
                                        key={operation.key}
                                        onClick={onSelect}
                                        type="button"
                                    >
                                        <span className="truncate">{operation.summary}</span>
                                        <MethodBadge kind={operation.kind} method={operation.method} />
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                    {groups.length === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="api-nav-empty">
                            {t("No operations match your filter.")}
                        </p>
                    )}
                </div>
            </nav>

            {selected === undefined ? (
                <div className="lg:col-span-2" />
            ) : (
                // One run state per operation, shared by the centre console and the right-rail
                // response. Keyed on the operation so switching remounts it clean (no reset effect).
                <OperationRunProvider key={selected.key} operation={selected}>
                    <div className="min-w-0 overflow-y-auto p-6" data-testid="api-reference-main">
                        <OperationView operation={selected} />
                    </div>
                    <aside className="flex min-w-0 flex-col gap-4 overflow-y-auto border-border p-4 lg:border-l" data-testid="api-reference-aside">
                        <CodeSamples operation={selected} server={server} />
                        <ResponsePanel />
                    </aside>
                </OperationRunProvider>
            )}
        </div>
    );
};

export default ReferenceView;
