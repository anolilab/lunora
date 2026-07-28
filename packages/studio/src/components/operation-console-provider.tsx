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
    /** True when the drawer should render errors only. */
    readonly errorsOnly: boolean;
    /** Which entry to highlight, or `undefined` for no particular one. */
    readonly focusSeq: number | undefined;
    readonly open: boolean;
    readonly openConsole: (options?: OpenConsoleOptions) => void;
    readonly toggle: () => void;
}

/**
 * Default value for a tree with no provider. Deliberately inert rather than
 * throwing: `ErrorAlert` is rendered in unit tests and in isolated stories that
 * mount no shell, and an error component that itself throws because a debugging
 * affordance is unavailable would be the worst possible failure mode.
 */
const INERT: OperationConsoleValue = {
    close: () => {},
    errorsOnly: false,
    focusSeq: undefined,
    open: false,
    openConsole: () => {},
    toggle: () => {},
};

const OperationConsoleContext = createContext<OperationConsoleValue>(INERT);

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
    const [state, setState] = useState<{ errorsOnly: boolean; focusSeq: number | undefined; open: boolean }>({
        errorsOnly: false,
        focusSeq: undefined,
        open: false,
    });

    const value = useMemo<OperationConsoleValue>(() => {
        return {
            close: () => {
                setState((current) => {
                    return { ...current, open: false };
                });
            },
            errorsOnly: state.errorsOnly,
            focusSeq: state.focusSeq,
            open: state.open,
            openConsole: (options?: OpenConsoleOptions) => {
                setState({ errorsOnly: options?.errorsOnly ?? false, focusSeq: options?.seq, open: true });
            },
            toggle: () => {
                // Toggling from the keyboard clears any prior focus: the operator is
                // asking for the tape, not for the entry some earlier error pinned.
                setState((current) => {
                    return { errorsOnly: false, focusSeq: undefined, open: !current.open };
                });
            },
        };
    }, [state]);

    return <OperationConsoleContext value={value}>{children}</OperationConsoleContext>;
};

/** Read the operation console's UI state. Inert outside a provider — see {@link INERT}. */
export const useOperationConsole = (): OperationConsoleValue => use(OperationConsoleContext);

export type { OpenConsoleOptions, OperationConsoleValue };
