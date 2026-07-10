import { LunoraProvider } from "@lunora/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from "react-native";

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
        <QueryClientProvider client={queryClient}>
            <LunoraProvider client={lunoraClient}>
                <SafeAreaView style={styles.container}>
                    <Root />
                    <StatusBar style="auto" />
                </SafeAreaView>
            </LunoraProvider>
        </QueryClientProvider>
    );
}

const styles = StyleSheet.create({
    centered: { alignItems: "center", flex: 1, justifyContent: "center" },
    container: { backgroundColor: "#fff", flex: 1 },
});
