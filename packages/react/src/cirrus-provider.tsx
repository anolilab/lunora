import type { CirrusClient } from "@cirrus/client";
import { createContext, type ReactElement, type ReactNode, useContext } from "react";

const CirrusContext = createContext<CirrusClient | null>(null);

export interface CirrusProviderProps {
    children: ReactNode;
    client: CirrusClient;
}

export const CirrusProvider = ({ client, children }: CirrusProviderProps): ReactElement => {
    return <CirrusContext.Provider value={client}>{children}</CirrusContext.Provider>;
};

/** Read the {@link CirrusClient} from the nearest `<CirrusProvider>`. */
export const useCirrus = (): CirrusClient => {
    const client = useContext(CirrusContext);

    if (!client) {
        throw new Error("useCirrus must be used inside <CirrusProvider />");
    }

    return client;
};
