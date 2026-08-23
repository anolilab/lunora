import { LunoraProvider } from "@lunora/react-native";
import { expoBearerToken } from "@lunora/react-native/auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { authClient } from "./src/auth-client";
import { Chat } from "./src/Chat";
import { Login } from "./src/Login";
import { lunoraClient } from "./src/lunora";

// One QueryClient for the app. Lunora is push-driven, so live queries never go
// stale on their own — the WebSocket subscription is the only invalidation.
const queryClient = new QueryClient();

/** Flip between the sign-in screen and the chat based on the better-auth session. */
function Root(): ReactElement {
    const { data: session, isPending } = authClient.useSession();

    // Bridge the better-auth Expo session into the Lunora client as a bearer
    // token — HTTP `Authorization` (`setAuthToken`) and the WS `?token=`
    // (`setWsToken`) — re-synced whenever the session changes (sign-in/out).
    // `expoBearerToken` is async since better-auth 1.7.1, and an async function is
    // not a valid effect cleanup return — so kick off a promise instead. The
    // `cancelled` flag is load-bearing, not ceremony: two session changes in quick
    // succession leave two reads in flight, and without it the SLOWER one wins and
    // reinstates the previous session's token. React runs this cleanup before the
    // next effect, so a superseded read can no longer apply.
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            const token = await expoBearerToken(authClient);

            if (cancelled) {
                return;
            }

            lunoraClient.setAuthToken(token);
            lunoraClient.setWsToken(token ?? undefined);
        })();

        return () => {
            cancelled = true;
        };
    }, [session]);

    if (isPending) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    return session ? <Chat /> : <Login />;
}

export default function App(): ReactElement {
    return (
        <SafeAreaProvider>
            <QueryClientProvider client={queryClient}>
                <LunoraProvider client={lunoraClient}>
                    <SafeAreaView style={styles.container}>
                        <Root />
                        <StatusBar style="auto" />
                    </SafeAreaView>
                </LunoraProvider>
            </QueryClientProvider>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    centered: { alignItems: "center", flex: 1, justifyContent: "center" },
    container: { backgroundColor: "#fff", flex: 1 },
});
