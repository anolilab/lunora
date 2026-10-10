import type { ReactElement } from "react";

import type { AssistantSession } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";

/** The session switcher: pick a conversation, start one, drop one. */
const AssistantSessionBar = ({
    activeId,
    onDelete,
    onNew,
    onSelect,
    sessions,
}: {
    readonly activeId: string | undefined;
    readonly onDelete: (id: string) => void;
    readonly onNew: () => void;
    readonly onSelect: (id: string) => void;
    readonly sessions: ReadonlyArray<AssistantSession>;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" data-testid="assistant-sessions">
            {sessions.map((session) => (
                <span className="flex shrink-0 items-center" key={session.id}>
                    <Button
                        data-testid="assistant-session"
                        onClick={() => {
                            onSelect(session.id);
                        }}
                        size="xs"
                        type="button"
                        variant={session.id === activeId ? "secondary" : "ghost"}
                    >
                        {session.name}
                    </Button>
                    {sessions.length > 1 && (
                        <Button
                            aria-label={t("Close chat")}
                            data-testid="assistant-session-close"
                            onClick={() => {
                                onDelete(session.id);
                            }}
                            size="xs"
                            type="button"
                            variant="ghost"
                        >
                            ×
                        </Button>
                    )}
                </span>
            ))}
            <Button aria-label={t("New chat")} className="shrink-0" data-testid="assistant-session-new" onClick={onNew} size="xs" type="button" variant="ghost">
                +
            </Button>
        </div>
    );
};

export default AssistantSessionBar;
