import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { useT } from "../i18n-context";
import CodeSamples from "./code-samples";
import MethodBadge from "./method-badge";
import type { ApiModel } from "./openapi-model";
import OperationView from "./operation-view";

interface ReferenceViewProps {
    readonly model: ApiModel;
}

/**
 * The shared, spec-agnostic API reference UI: a three-column layout — a
 * tag-grouped operation sidebar, the selected operation's documentation +
 * live try-it console, and a right rail of copy-paste request samples. It
 * renders any {@link ApiModel}, so both the OpenAPI and OpenRPC panels drive
 * the *same* UI through their respective parsers — replacing the embedded
 * Scalar reference (and the old bespoke OpenRPC viewer) with one native,
 * overlay-free surface that themes to the studio and ships no extra bundle.
 */
const ReferenceView = ({ model }: ReferenceViewProps): ReactElement => {
    const t = useT();

    const firstKey = model.groups[0]?.operations[0]?.key ?? "";
    const [selectedKey, setSelectedKey] = useState<string>(firstKey);

    // The selection falls back to the first operation until the user picks one,
    // and self-heals if the spec reloads and the previous key is gone.
    const selected = useMemo(() => model.operationByKey.get(selectedKey) ?? model.operationByKey.get(firstKey), [model, selectedKey, firstKey]);

    const onSelect = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        const { key } = event.currentTarget.dataset;

        if (key !== undefined) {
            setSelectedKey(key);
        }
    }, []);

    const server = model.server ?? "";

    return (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)_20rem]" data-testid="api-reference">
            {/* Operation sidebar — pinned, scrolls its own nav. */}
            <nav aria-label={t("API operations")} className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border p-4" data-testid="api-reference-nav">
                {model.groups.map((group) => (
                    <div className="flex flex-col gap-1" key={group.name}>
                        <span className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{group.name || t("(root)")}</span>
                        {group.operations.map((operation) => {
                            const active = operation.key === selected?.key;

                            return (
                                <button
                                    aria-current={active ? "page" : undefined}
                                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-start text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
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
            </nav>

            {/* Centre: the selected operation's documentation + try-it. */}
            <div className="min-w-0 overflow-y-auto p-6" data-testid="api-reference-main">
                {selected !== undefined && <OperationView operation={selected} />}
            </div>

            {/* Right rail: request samples. Drops below the centre column on narrow widths. */}
            <aside className="min-w-0 overflow-y-auto border-border p-4 lg:border-l" data-testid="api-reference-aside">
                {selected !== undefined && <CodeSamples operation={selected} server={server} />}
            </aside>
        </div>
    );
};

export default ReferenceView;
