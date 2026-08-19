import type { ReactElement, ReactNode } from "react";
import { createContext, use, useState } from "react";

import { useAdminQuery } from "../hooks/use-admin-query";
import type { AiAvailableResult, ChatTurn, SchemaFact } from "../lib/admin";
import { ADMIN_FUNCTIONS } from "../lib/admin";

/** What a surface hands the assistant when it opens it. */
interface AssistantSeed {
    /**
     * A question to ask straight away, on the operator's behalf.
     *
     * This is what "Explain this error" / "Why is this advisor firing" pass: the
     * operator already expressed the intent by clicking, so making them press
     * Send again is ceremony. Mutually useful with {@link AssistantSeed.draft} —
     * a surface uses one or the other, never both.
     */
    readonly ask?: string;

    /** Text to PREFILL the composer with, unsent, for the operator to edit first. */
    readonly draft?: string;

    /**
     * Tables and columns to ground the turn in.
     *
     * Absent means the assistant is ungrounded and the system prompt's "never
     * invent names" rule has nothing to check against, so a surface that knows
     * the schema should always pass it. Only names and column names travel — no
     * row values, which is the boundary `inferChart` also holds.
     */
    readonly schema?: ReadonlyArray<SchemaFact>;

    /** Which shard the turn's tools read. Absent means the worker's root shard. */
    readonly shardKey?: string;

    /**
     * A name for the session this seed opens, shown in the session list.
     *
     * Already display-ready: a caller with a catalog id translates it itself (it
     * has `t`), and a caller naming runtime data — an advisor finding's headline —
     * passes that through. The provider has no `t` and must not invent an id for
     * text it did not author.
     */
    readonly title?: string;
}

/** One conversation. Named, because an operator with four open needs to tell them apart. */
interface AssistantSession {
    readonly id: string;
    readonly name: string;
    /** Grounding and shard for THIS session, captured from the seed that opened it. */
    readonly schema: ReadonlyArray<SchemaFact>;
    readonly shardKey: string | undefined;
    readonly turns: ReadonlyArray<ChatTurn>;
}

/** A pending seeded question, keyed so asking the SAME thing twice asks twice. */
interface PendingAsk {
    readonly id: number;
    readonly sessionId: string;
    readonly text: string;
}

/** The assistant's shell-wide state, shared so any panel can open it without prop-drilling. */
interface AssistantValue {
    readonly activeId: string | undefined;
    readonly close: () => void;
    readonly deleteChat: (id: string) => void;
    /** The composer's prefilled text and the seed that set it, so a re-seed replaces it. */
    readonly draft: { readonly id: number; readonly text: string } | undefined;

    /**
     * Where "Insert into editor" puts a statement, or `undefined` when the page
     * showing has no editor.
     *
     * Registered by the page rather than owned by the panel, because the panel is
     * shell-wide and the editor is not: on the Issues page a reply may well
     * contain SQL, and offering to insert it somewhere the operator cannot see
     * would be a button that silently does nothing. Absent, the panel renders no
     * insert button at all.
     */
    readonly insert: ((sql: string) => void) | undefined;
    /** Start a fresh session and open the panel on it. */
    readonly newChat: (seed?: AssistantSeed) => void;
    readonly open: boolean;

    /**
     * Open the panel, reusing the current session when the seed adds nothing new.
     *
     * A seed carrying an `ask` always starts a fresh session: the seeded question
     * arrives with its own context (a specific error, a specific lint), and
     * appending it to whatever was already being discussed is how a transcript
     * becomes two conversations interleaved.
     */
    readonly openAssistant: (seed?: AssistantSeed) => void;
    /** The seeded question awaiting a send, or `undefined`. Cleared by {@link AssistantValue.takeAsk}. */
    readonly pendingAsk: PendingAsk | undefined;
    readonly selectChat: (id: string) => void;
    readonly sessions: ReadonlyArray<AssistantSession>;
    /** Register (or, with `undefined`, withdraw) the page's insert target. */
    readonly setInsert: (insert: ((sql: string) => void) | undefined) => void;
    /** Replace a session's transcript. The panel owns sending; this is where the result lands. */
    readonly setTurns: (id: string, turns: ReadonlyArray<ChatTurn>) => void;
    /** Mark the pending ask consumed, so a re-render never re-asks it. */
    readonly takeAsk: (id: number) => void;
    readonly toggle: () => void;

    /**
     * True once the deployment has reported it cannot run the assistant — no `AI`
     * binding, or `LUNORA_AI_OPT_IN=disabled`.
     *
     * Owned HERE rather than by each surface, and asked ONCE for the shell. Every
     * entry point must gate on it: a button that opens a panel which then reports
     * it cannot work is the exact failure `aiAvailable` was added to prevent, and
     * before this the four shell-wide entry points reintroduced it — they gated on
     * "is a provider mounted", which is a different question.
     */
    readonly unavailable: boolean;
}

/**
 * `undefined` outside a provider, so a consumer can tell "no assistant is
 * mounted" from "one is mounted and closed" and render nothing rather than a
 * dead control — the same contract, for the same reason, as
 * `useOperationConsole`. A host embedding a single Studio panel bare gets no
 * "Ask the assistant" button at all instead of one that silently does nothing.
 */
const AssistantContext = createContext<AssistantValue | undefined>(undefined);

/** Stable empty args, so the availability query is not re-keyed every render. */
const NO_ARGS: Record<string, unknown> = {};

/** The default name a session gets before the operator or a seed names it. */
const UNTITLED = "New chat";

/** Sessions kept before the oldest is dropped. A console scratchpad, not an archive. */
const MAX_SESSIONS = 10;

/** Internal state shape. One object so every transition is a single, atomic update. */
interface AssistantState {
    readonly activeId: string | undefined;
    readonly draft: { readonly id: number; readonly text: string } | undefined;
    readonly insert: ((sql: string) => void) | undefined;
    readonly open: boolean;
    readonly pendingAsk: PendingAsk | undefined;
    /** Monotonic, so two identical seeds are two distinct events rather than one swallowed prop change. */
    readonly seq: number;
    readonly sessions: ReadonlyArray<AssistantSession>;
}

/** Fresh session from a seed. */
const sessionFrom = (id: string, seed: AssistantSeed | undefined): AssistantSession => {
    return { id, name: seed?.title ?? UNTITLED, schema: seed?.schema ?? [], shardKey: seed?.shardKey, turns: [] };
};

/** Append a session, evicting the oldest past the cap. */
const withSession = (current: AssistantState, session: AssistantSession): ReadonlyArray<AssistantSession> =>
    [...current.sessions, session].slice(-MAX_SESSIONS);

/** Open a brand-new session from a seed. The one transition three actions share. */
const start = (current: AssistantState, seed: AssistantSeed | undefined): AssistantState => {
    const id = `chat-${String(current.seq + 1)}`;

    return {
        activeId: id,
        draft: seed?.draft === undefined ? undefined : { id: current.seq + 1, text: seed.draft },
        // Carried over rather than cleared: the insert target belongs to the PAGE,
        // and starting a conversation does not navigate anywhere.
        insert: current.insert,
        open: true,
        pendingAsk: seed?.ask === undefined ? undefined : { id: current.seq + 1, sessionId: id, text: seed.ask },
        seq: current.seq + 1,
        sessions: withSession(current, sessionFrom(id, seed)),
    };
};

/** One session dropped. Hoisted for the same reason as {@link retold}. */
const without = (sessions: ReadonlyArray<AssistantSession>, id: string): ReadonlyArray<AssistantSession> => sessions.filter((session) => session.id !== id);

/** One session's transcript replaced. Hoisted so the action below stays one nesting level shallower. */
const retold = (sessions: ReadonlyArray<AssistantSession>, id: string, turns: ReadonlyArray<ChatTurn>): ReadonlyArray<AssistantSession> =>
    sessions.map((session) => (session.id === id ? { ...session, turns } : session));

/**
 * Holds the assistant's sessions and open state for the whole Studio shell.
 *
 * **Lifted here rather than owned by the SQL console** — which is where it
 * started — because a transcript that dies when you navigate is a transcript you
 * stop using. Every panel can now open the assistant with the context it already
 * has on screen, which is the difference between an assistant and a text box on
 * one page.
 *
 * **Not persisted.** Plan 364 argued this and it still holds: a console chat is
 * a scratchpad, and persisting it means a retention policy plus another store of
 * raw statements outliving the browser. Sessions survive navigation, not a
 * reload.
 */
export const AssistantProvider = ({ children }: { readonly children: ReactNode }): ReactElement => {
    // Asked once for the whole shell, on the root shard: whether the assistant can
    // run is a property of the DEPLOYMENT, not of the page or the shard being
    // browsed, so re-asking it per surface would be the same answer N times.
    const availability = useAdminQuery<AiAvailableResult>(ADMIN_FUNCTIONS.aiAvailable, NO_ARGS, { shardKey: "" });

    const [state, setState] = useState<AssistantState>({
        activeId: undefined,
        draft: undefined,
        insert: undefined,
        open: false,
        pendingAsk: undefined,
        seq: 0,
        sessions: [],
    });

    // Same lazy-initialiser contract as `OperationConsoleProvider` — see the note
    // there for why it is not a ref and not a `[state]` memo. Every setter is an
    // updater function, so none of them closes over the current state.
    const [actions] = useState(() => {
        return {
            close: (): void => {
                setState((current) => {
                    return { ...current, open: false };
                });
            },

            deleteChat: (id: string): void => {
                setState((current) => {
                    const sessions = without(current.sessions, id);

                    return {
                        ...current,
                        // Falling back to the LAST remaining session rather than to
                        // `undefined`: deleting the active one should land the operator on
                        // another conversation, not on an empty panel they have to reopen.
                        activeId: current.activeId === id ? sessions.at(-1)?.id : current.activeId,
                        sessions,
                    };
                });
            },

            newChat: (seed?: AssistantSeed): void => {
                setState((current) => start(current, seed));
            },

            openAssistant: (seed?: AssistantSeed): void => {
                setState((current) => {
                    // A seeded question always gets its own session — see the docblock on
                    // `openAssistant`. So does the very first open, which has none to reuse.
                    if (seed?.ask !== undefined || current.activeId === undefined) {
                        return start(current, seed);
                    }

                    return {
                        ...current,
                        draft: seed?.draft === undefined ? current.draft : { id: current.seq + 1, text: seed.draft },
                        open: true,
                        seq: current.seq + 1,
                    };
                });
            },

            setInsert: (insert: ((sql: string) => void) | undefined): void => {
                setState((current) => {
                    return { ...current, insert };
                });
            },

            selectChat: (id: string): void => {
                setState((current) => {
                    return { ...current, activeId: id, open: true };
                });
            },

            setTurns: (id: string, turns: ReadonlyArray<ChatTurn>): void => {
                setState((current) => {
                    return {
                        ...current,
                        sessions: retold(current.sessions, id, turns),
                    };
                });
            },

            toggle: (): void => {
                setState((current) => {
                    // Toggling open with nothing to show starts a session, so the panel is
                    // never opened onto an empty shell.
                    if (!current.open && current.activeId === undefined) {
                        return start(current, undefined);
                    }

                    return { ...current, open: !current.open };
                });
            },

            takeAsk: (id: number): void => {
                setState((current) =>
                    // Compared by id, so a seed that arrived while this one was being consumed
                    // is not thrown away with it.
                    current.pendingAsk?.id === id ? { ...current, pendingAsk: undefined } : current,
                );
            },
        };
    });
    // Built inline, not memoized: React Compiler auto-memoizes the context value
    // for this package, and `actions` is already identity-stable.
    const value: AssistantValue = {
        ...actions,
        activeId: state.activeId,
        draft: state.draft,
        insert: state.insert,
        open: state.open,
        pendingAsk: state.pendingAsk,
        sessions: state.sessions,
        unavailable: availability.data?.available === false,
    };

    return <AssistantContext value={value}>{children}</AssistantContext>;
};

/**
 * Read the assistant's shell state, or `undefined` when none is mounted above
 * this tree. Callers MUST treat `undefined` as "do not offer the affordance"
 * rather than rendering a control that cannot work.
 */
export const useAssistant = (): AssistantValue | undefined => use(AssistantContext);

export type { AssistantSeed, AssistantSession, AssistantValue };
