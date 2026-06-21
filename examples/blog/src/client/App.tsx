import type { ReactElement } from "react";

import { Auth } from "./Auth.js";
import { authClient } from "./auth-client.js";
import { Dashboard } from "./Dashboard.js";

export const App = (): ReactElement => {
    const session = authClient.useSession();

    if (session.isPending) {
        return <p style={{ margin: "4rem auto", textAlign: "center" }}>Loading…</p>;
    }

    return session.data ? <Dashboard /> : <Auth />;
};
