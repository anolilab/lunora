import { useAuth } from "@cirrus/react";
import type { ReactElement } from "react";

import { Chat } from "./Chat.js";
import { Login } from "./Login.js";

export const App = (): ReactElement => {
    const { token } = useAuth();

    if (!token) {
        return <Login />;
    }

    return <Chat />;
};
