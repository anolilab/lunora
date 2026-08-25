import type { ReactElement, ReactNode } from "react";
import { createContext, use, useState } from "react";

import { useAdminQuery } from "../hooks/use-admin-query";
import type { AiAvailableResult, AiOptInLevel, ChatPendingApproval, ChatTurn, SchemaFact } from "../lib/admin";
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
     * Starter questions for an empty panel.
     *
     * A blank composer asks the operator to invent a question about a surface they
     * opened precisely because they did not know what to ask. The surface that
     * opened it usually does know — the SQL console can offer questions about the
     * schema it has probed, an advisor row about the finding it is showing.
     */
    readonly suggestions?: ReadonlyArray<string>;

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
    /** Starter questions shown while the transcript is empty. */
    readonly suggestions: ReadonlyArray<string>;
    readonly turns: ReadonlyArray<SessionTurn>;
}

/**
 * One turn as the STUDIO holds it: the wire turn plus what the server reported
 * that turn did.
 *
 * `toolCalls` is local-only and never re-sent — the transcript the server budgets
 * and fences is prose, and echoing a record of its own tool calls back at it
 * would spend that budget on something it already knows.
 */
interface SessionTurn extends ChatTurn {
    /** True when the turn hit the per-turn tool cap and answered with what it had. */
    readonly partial?: boolean;

    /**
     * A read the turn stopped at, waiting for the operator to allow or deny it.
     *
     * Local-only and never re-sent, like `toolCalls`: the server re-derives the
     * request from the model on the follow-up turn and verifies the ticket against
     * THAT, so replaying this back at it would prove nothing.
     */
    readonly pendingApproval?: ChatPendingApproval;
    readonly toolCalls?: ReadonlyArray<{
        readonly name?: string;
        /** Set only when the deployment's data-sharing level is what refused the tool. */
        readonly needs?: AiOptInLevel;
        readonly refused?: string;
        readonly sql?: string;
    }>;
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
    /** Copy a session's turns up to and including `index` into a new session, and open it. */
    readonly branchFrom: (id: string, index: number) => void;
    readonly close: () => void;
    readonly deleteChat: (id: string) => void;

    /** The composer's prefilled text and the seed that set it, so a re-seed replaces it. */
    readonly draft: { readonly id: number; readonly text: string } | undefined;

    /**
     * Whether the page showing has somewhere to put a statement.
     *
     * A boolean rather than the callback it replaced. The panel is shell-wide and
     * the editor is not — on the Issues page a reply may well contain SQL, and
     * offering to insert it somewhere the operator cannot see would be a button
     * that silently does nothing — so the page still has to say. But *where* it
     * goes is the page's business, not the provider's: storing a closure here made
     * this state unserialisable, needed a mirrored ref at the registration site to
     * avoid pinning the sink to one render's tab, and let two mounted editors
     * clobber each other's sink. A boolean is idempotent, so the worst a double
     * registration can do is set true twice.
     */
    readonly hasEditor: boolean;

    /**
     * A statement the panel asked the page to insert, awaiting collection.
     *
     * Id-keyed like {@link AssistantValue.draft} and
     * {@link AssistantValue.pendingAsk} — the same "one side offers, the other
     * takes it exactly once" shape this provider already uses twice, so inserting
     * the SAME statement twice is two events rather than one swallowed prop change.
     */
    readonly insertRequest: { readonly id: number; readonly sql: string } | undefined;

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
    /** Offer a statement to whatever page is showing. Called by the panel. */
    readonly requestInsert: (sql: string) => void;
    readonly selectChat: (id: string) => void;
    readonly sessions: ReadonlyArray<AssistantSession>;
    /** Declare whether this page can accept an insert. Called by the page, withdrawn on unmount. */
    readonly setHasEditor: (present: boolean) => void;
    /** Replace a session's transcript. The panel owns sending; this is where the result lands. */
    readonly setTurns: (id: string, turns: ReadonlyArray<SessionTurn>) => void;
    /** Mark the pending ask consumed, so a re-render never re-asks it. */
    readonly takeAsk: (id: number) => void;
    /** Mark an insert request collected, so a re-render never re-inserts it. */
    readonly takeInsert: (id: number) => void;
    readonly toggle: () => void;
    /** Drop every turn from `index` onward — the operator rewinding a conversation that went wrong. */
    readonly truncateFrom: (id: string, index: number) => void;

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
    readonly hasEditor: boolean;
    readonly insertRequest: { readonly id: number; readonly sql: string } | undefined;
    readonly open: boolean;
    readonly pendingAsk: PendingAsk | undefined;
    /** Monotonic, so two identical seeds are two distinct events rather than one swallowed prop change. */
    readonly seq: number;
    readonly sessions: ReadonlyArray<AssistantSession>;
}

/** Fresh session from a seed. */
const sessionFrom = (id: string, seed: AssistantSeed | undefined): AssistantSession => {
    return { id, name: seed?.title ?? UNTITLED, schema: seed?.schema ?? [], shardKey: seed?.shardKey, suggestions: seed?.suggestions ?? [], turns: [] };
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
        // Carried over rather than cleared: whether the page has an editor belongs
        // to the PAGE, and starting a conversation does not navigate anywhere. Any
        // uncollected request is dropped, though — it belonged to the old session.
        hasEditor: current.hasEditor,
        insertRequest: undefined,
        open: true,
        pendingAsk: seed?.ask === undefined ? undefined : { id: current.seq + 1, sessionId: id, text: seed.ask },
        seq: current.seq + 1,
        sessions: withSession(current, sessionFrom(id, seed)),
    };
};

/** One session by id, or `undefined`. Hoisted so the actions that need it stay one nesting level shallower. */
const sessionById = (sessions: ReadonlyArray<AssistantSession>, id: string): AssistantSession | undefined => sessions.find((session) => session.id === id);

/** One session dropped. Hoisted for the same reason as {@link retold}. */
const without = (sessions: ReadonlyArray<AssistantSession>, id: string): ReadonlyArray<AssistantSession> => sessions.filter((session) => session.id !== id);

/** One session's transcript replaced. Hoisted so the action below stays one nesting level shallower. */
const retold = (sessions: ReadonlyArray<AssistantSession>, id: string, turns: ReadonlyArray<SessionTurn>): ReadonlyArray<AssistantSession> =>
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
        hasEditor: false,
        insertRequest: undefined,
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
                    const active = current.activeId === undefined ? undefined : sessionById(current.sessions, current.activeId);

                    /*
                     * A seeded question always gets its own session — see the docblock
                     * on `openAssistant`. So does the very first open, which has none
                     * to reuse.
                     *
                     * And so does a seed naming a DIFFERENT shard: a conversation is
                     * about one shard, its transcript is grounded in that shard's
                     * schema, and its tools read it. Reusing the session across a
                     * shard change silently mixed the two — earlier answers describing
                     * one database, later tool reads hitting another.
                     */
                    if (seed?.ask !== undefined || active === undefined || (seed?.shardKey !== undefined && seed.shardKey !== active.shardKey)) {
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

            requestInsert: (sql: string): void => {
                setState((current) => {
                    return { ...current, insertRequest: { id: current.seq + 1, sql }, seq: current.seq + 1 };
                });
            },

            setHasEditor: (present: boolean): void => {
                setState((current) => (current.hasEditor === present ? current : { ...current, hasEditor: present }));
            },

            takeInsert: (id: number): void => {
                setState((current) =>
                    // By id, so a request that arrived while this one was being
                    // collected is not thrown away with it.
                    current.insertRequest?.id === id ? { ...current, insertRequest: undefined } : current,
                );
            },

            selectChat: (id: string): void => {
                setState((current) => {
                    return { ...current, activeId: id, open: true };
                });
            },

            branchFrom: (id: string, index: number): void => {
                setState((current) => {
                    const source = sessionById(current.sessions, id);

                    if (source === undefined) {
                        return current;
                    }

                    // A branch carries the source's grounding as well as its turns:
                    // the new conversation is about the same shard and the same
                    // schema, and re-deriving that would make it about neither.
                    const next = start(current, { schema: source.schema, shardKey: source.shardKey, title: source.name });

                    return { ...next, sessions: retold(next.sessions, next.activeId ?? "", source.turns.slice(0, index + 1)) };
                });
            },

            setTurns: (id: string, turns: ReadonlyArray<SessionTurn>): void => {
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

            truncateFrom: (id: string, index: number): void => {
                setState((current) => {
                    const source = sessionById(current.sessions, id);

                    return source === undefined ? current : { ...current, sessions: retold(current.sessions, id, source.turns.slice(0, index)) };
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
        hasEditor: state.hasEditor,
        insertRequest: state.insertRequest,
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

export type { AssistantSeed, AssistantSession, AssistantValue, SessionTurn };
