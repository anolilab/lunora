import type { ReactElement, ReactNode } from "react";
import { createContext, use, useMemo, useState } from "react";

/** How a caller wants the console opened. */
interface OpenConsoleOptions {
    /** Show only failed operations — what an error surface almost always wants. */
    readonly errorsOnly?: boolean;
    /** Scroll to and highlight this tape entry. */
    readonly seq?: number;
}

/** The console's UI state, shared so any panel can open it without prop-drilling. */
interface OperationConsoleValue {
    readonly close: () => void;
    /** Which entry to highlight, or `undefined` for no particular one. */
    readonly focusSeq: number | undefined;
    readonly open: boolean;
    readonly openConsole: (options?: OpenConsoleOptions) => void;

    /**
     * Which operations the drawer lists. Owned HERE rather than seeded into the
     * drawer's local state: the drawer only remounts when `open` flips, so a
     * seeded copy silently ignored `openConsole({ errorsOnly: true })` whenever
     * the drawer was already open — the button did nothing, which is worse than
     * not offering it.
     */
    readonly setShown: (shown: ConsoleShown) => void;
    readonly shown: ConsoleShown;
    readonly toggle: () => void;
}

/** Which operations the console lists. */
type ConsoleShown = "all" | "errors";

/**
 * `undefined` outside a provider, so a consumer can tell "no console is mounted"
 * from "a console is mounted and closed" and render nothing rather than a dead
 * control. A host embedding a single Studio panel without the shell gets no
 * button at all instead of one that silently does nothing on every error.
 *
 * Deliberately NOT a throwing context: `ErrorAlert` is rendered standalone by
 * other suites, and an error component that crashes because a debugging
 * affordance is unavailable is the worst possible failure mode.
 */
const OperationConsoleContext = createContext<OperationConsoleValue | undefined>(undefined);

/**
 * Holds the operation console's open/focus state for the whole Studio shell.
 *
 * Separate from the tape itself (`lib/operation-log.ts`, a module singleton
 * because the recording choke point is not a component): recording is always on
 * and independent of whether anything is rendered, while *showing* the drawer is
 * ordinary UI state. Lifting it here is what lets `ErrorAlert` — rendered deep
 * inside panels — turn a red callout into "show me the call that failed".
 */
export const OperationConsoleProvider = ({ children }: { readonly children: ReactNode }): ReactElement => {
    const [state, setState] = useState<{ focusSeq: number | undefined; open: boolean; shown: ConsoleShown }>({
        focusSeq: undefined,
        open: false,
        shown: "all",
    });

    /*
     * Actions are created ONCE by a lazy `useState` initialiser, not a ref.
     *
     * A ref would be read during render to build the context value, which
     * React Compiler forbids (and React Doctor flags as an error) — a render
     * must not depend on mutable state the compiler cannot track. `useState`
     * with an initialiser gives the same never-changing identities while
     * staying a legal render-time read. Every setter is an updater function, so
     * none of them closes over the current state. `StudioLayoutShell`'s
     * keydown effect depends on `toggle`; folding the actions into a `[state]`
     * memo would give it a new identity on every open/close and tear down and
     * re-register the window listener each time. Every setter is an updater
     * function, so none of them needs to close over the current state.
     */
    const [actions] = useState<Omit<OperationConsoleValue, "focusSeq" | "open" | "shown">>(() => {
        return {
            close: (): void => {
                setState((current) => {
                    return { ...current, open: false };
                });
            },
            openConsole: (options?: OpenConsoleOptions): void => {
                setState({ focusSeq: options?.seq, open: true, shown: options?.errorsOnly === true ? "errors" : "all" });
            },
            setShown: (shown: ConsoleShown): void => {
                setState((current) => {
                    return { ...current, shown };
                });
            },
            toggle: (): void => {
                // Toggling from the keyboard clears any prior focus and filter: the
                // operator is asking for the tape, not for the entry some earlier
                // error pinned.
                setState((current) => {
                    return { focusSeq: undefined, open: !current.open, shown: "all" };
                });
            },
        };
    });

    const value = useMemo<OperationConsoleValue>(() => {
        return { ...actions, focusSeq: state.focusSeq, open: state.open, shown: state.shown };
    }, [actions, state]);

    return <OperationConsoleContext value={value}>{children}</OperationConsoleContext>;
};

/**
 * Read the operation console's UI state, or `undefined` when no console is
 * mounted above this tree. Callers MUST treat `undefined` as "do not offer the
 * affordance" rather than rendering a control that cannot work.
 */
export const useOperationConsole = (): OperationConsoleValue | undefined => use(OperationConsoleContext);

export type { ConsoleShown, OpenConsoleOptions, OperationConsoleValue };
