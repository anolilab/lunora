import type { ReactElement } from "react";

import type { AssistantValue } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";

/** The session switcher: pick a conversation, start one, drop one. */
const SessionBar = ({ assistant }: { readonly assistant: AssistantValue }): ReactElement => {
    const t = useT();
    const { activeId, deleteChat, newChat, selectChat, sessions } = assistant;

    return (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" data-testid="assistant-sessions">
            {sessions.map((session) => (
                <span className="flex shrink-0 items-center" key={session.id}>
                    <Button
                        data-testid="assistant-session"
                        onClick={() => {
                            selectChat(session.id);
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
                                deleteChat(session.id);
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
            <Button
                aria-label={t("New chat")}
                className="shrink-0"
                data-testid="assistant-session-new"
                onClick={() => {
                    newChat({ title: t("New chat") });
                }}
                size="xs"
                type="button"
                variant="ghost"
            >
                +
            </Button>
        </div>
    );
};

export default SessionBar;
