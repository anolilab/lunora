import { useAuth } from "@cirrus/react";
import type { ReactElement } from "react";

import { Auth } from "./Auth.js";
import { Dashboard } from "./Dashboard.js";

export const App = (): ReactElement => {
    const { token } = useAuth();

    return token ? <Dashboard /> : <Auth />;
};
