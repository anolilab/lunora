import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "../../components/ui/input";
import type { AssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import type { SavedQuery } from "./sql-query-sidebar";

/**
 * Inline name + description editor for one saved query, with an optional
 * "Suggest" that drafts both from the statement.
 *
 * Suggesting FILLS THE FIELDS and stops there — Save is the accept step, and a
 * model-written label that applied itself would be a rename the operator never
 * asked for. It renders no button at all when the assistant cannot run here (or
 * when the query is still empty, so there is nothing to name), on the same latch
 * every other affordance uses.
 */
const SqlQueryRename = ({
    onCancel,
    onSave,
    query,
    rpc,
}: {
    readonly onCancel: () => void;
    readonly onSave: (name: string, description: string) => void;
    readonly query: SavedQuery;
    /** The shared assistant RPCs, or `undefined` when the sidebar is composed without them. */
    readonly rpc?: AssistantRpc;
}): ReactElement => {
    const t = useT();
    const [name, setName] = useState(query.name);
    const [description, setDescription] = useState(query.description ?? "");

    const canSuggest = rpc !== undefined && !rpc.unavailable && query.sql.trim() !== "";
    const pending = rpc?.pending("name") === true;
    const reason = rpc?.reason("name");

    const suggest = (): void => {
        if (rpc === undefined) {
            return;
        }

        const draft = async (): Promise<void> => {
            const suggestion = await rpc.nameQuery(query.sql);

            if (suggestion !== undefined) {
                setName(suggestion.title);
                setDescription(suggestion.description);
            }
        };

        fireAndForget(draft());
    };

    // Structurally typed (not `React.FormEvent`, which the lint flags as
    // deprecated) — all we need off the submit event is `preventDefault`.
    const submit = (event: { preventDefault: () => void }): void => {
        event.preventDefault();

        const trimmed = name.trim();

        if (trimmed === "") {
            return;
        }

        onSave(trimmed, description.trim());
    };

    return (
        <form className="flex flex-col gap-1 rounded-md bg-sidebar-accent p-1.5" data-testid={`sql-query-rename-${query.id}`} onSubmit={submit}>
            <Input
                aria-label={t("Query name")}
                autoFocus
                className="h-7 text-xs"
                data-testid="sql-query-name"
                onChange={(event) => {
                    setName(event.target.value);
                }}
                placeholder={t("Query name")}
                value={name}
            />
            <Input
                aria-label={t("Query description")}
                className="h-7 text-xs"
                data-testid="sql-query-description"
                onChange={(event) => {
                    setDescription(event.target.value);
                }}
                placeholder={t("Query description")}
                value={description}
            />
            <div className="flex items-center gap-1">
                <button
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    data-testid="sql-query-rename-save"
                    type="submit"
                >
                    {t("Save")}
                </button>
                <button
                    className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                    data-testid="sql-query-rename-cancel"
                    onClick={onCancel}
                    type="button"
                >
                    {t("Cancel")}
                </button>
                {canSuggest && (
                    <button
                        className="ms-auto rounded-md border border-border px-2 py-0.5 text-[11px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        data-testid="sql-query-suggest-name"
                        disabled={pending}
                        onClick={suggest}
                        type="button"
                    >
                        {pending ? t("Thinking…") : t("Suggest")}
                    </button>
                )}
            </div>
            {reason !== undefined && (
                <p className="text-[11px] text-muted-foreground" data-testid="sql-query-name-reason" role="status">
                    {reason === "ai-error" ? t("The model could not be reached.") : t("The model returned nothing usable.")}
                </p>
            )}
        </form>
    );
};

export default SqlQueryRename;
