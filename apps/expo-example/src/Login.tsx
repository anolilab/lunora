import type { ReactElement } from "react";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { authClient } from "./auth-client";

/**
 * Email/password sign-in + sign-up against the worker's `/api/auth/*` routes.
 * On success, the better-auth Expo plugin stores the session in `SecureStore`
 * and `authClient.useSession()` in `App.tsx` flips to the chat on the next
 * render — no token to plumb through by hand.
 */
export function Login(): ReactElement {
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<null | string>(null);
    const [pending, setPending] = useState(false);

    const submit = (): void => {
        setError(null);
        setPending(true);

        void (async () => {
            try {
                const result =
                    mode === "signin"
                        ? await authClient.signIn.email({ email, password })
                        : await authClient.signUp.email({ email, name: name || email, password });

                if (result.error) {
                    setError(result.error.message ?? `${mode} failed`);
                }
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "unknown error");
            } finally {
                setPending(false);
            }
        })();
    };

    return (
        <View style={styles.container}>
            <Text style={styles.title}>{mode === "signin" ? "Sign in" : "Create account"}</Text>

            {mode === "signup" ? <TextInput autoCapitalize="words" onChangeText={setName} placeholder="Name" style={styles.input} value={name} /> : null}

            <TextInput
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="Email"
                style={styles.input}
                value={email}
            />

            <TextInput onChangeText={setPassword} placeholder="Password (min 8 chars)" secureTextEntry style={styles.input} value={password} />

            <TouchableOpacity disabled={pending} onPress={submit} style={styles.button}>
                {pending ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{mode === "signin" ? "Sign in" : "Sign up"}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
                onPress={() => {
                    setMode(mode === "signin" ? "signup" : "signin");
                    setError(null);
                }}
            >
                <Text style={styles.switch}>{mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}</Text>
            </TouchableOpacity>

            {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    button: { alignItems: "center", backgroundColor: "#3b82f6", borderRadius: 8, padding: 14 },
    buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
    container: { gap: 12, justifyContent: "center", padding: 24 },
    error: { color: "#dc2626", textAlign: "center" },
    input: { borderColor: "#d1d5db", borderRadius: 8, borderWidth: 1, fontSize: 16, padding: 12 },
    switch: { color: "#3b82f6", textAlign: "center" },
    title: { fontSize: 28, fontWeight: "700", marginBottom: 8, textAlign: "center" },
});
