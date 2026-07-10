import { useConnectionStatus, useMutation, useQuery } from "@lunora/react-native";
import type { ReactElement } from "react";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { authClient } from "./auth-client";
import { api } from "../lunora/_generated/api";

/** Human label + colour for the live-socket status badge. */
const STATUS: Record<string, { color: string; label: string }> = {
    connected: { color: "#16a34a", label: "live" },
    connecting: { color: "#d97706", label: "connecting…" },
    idle: { color: "#6b7280", label: "idle" },
    offline: { color: "#dc2626", label: "offline" },
};

/**
 * The chat screen. `useQuery` opens a live subscription — the list updates in
 * place as anyone posts — and `useMutation` sends optimistically (queued and
 * retried offline, thanks to the AsyncStorage persistence wired in
 * `src/lunora.ts`). `useConnectionStatus` drives the live/offline badge.
 */
export function Chat(): ReactElement {
    const { data: session } = authClient.useSession();
    const myUserId = session?.user.id;
    const myName = session?.user.name ?? session?.user.email ?? "me";

    const messages = useQuery(api.messages.list, {});
    const { mutate: send, pending } = useMutation(api.messages.send);
    const status = useConnectionStatus();

    const [draft, setDraft] = useState("");

    const handleSend = (): void => {
        const text = draft.trim();

        if (text === "" || pending) {
            return;
        }

        setDraft("");
        void send({ authorName: myName, text });
    };

    const badge = STATUS[status] ?? STATUS.idle;

    return (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
            <View style={styles.header}>
                <Text style={styles.title}>Chat</Text>
                <View style={styles.headerRight}>
                    <View style={[styles.dot, { backgroundColor: badge.color }]} />
                    <Text style={styles.status}>{badge.label}</Text>
                    <Pressable onPress={() => void authClient.signOut()}>
                        <Text style={styles.signOut}>Sign out</Text>
                    </Pressable>
                </View>
            </View>

            <FlatList
                contentContainerStyle={styles.listContent}
                data={messages ?? []}
                keyExtractor={(item) => item._id}
                renderItem={({ item }) => {
                    const mine = item.userId === myUserId;

                    return (
                        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                            {mine ? null : <Text style={styles.author}>{item.authorName}</Text>}
                            <Text style={mine ? styles.textMine : styles.textTheirs}>{item.text}</Text>
                        </View>
                    );
                }}
            />

            <View style={styles.composer}>
                <TextInput onChangeText={setDraft} onSubmitEditing={handleSend} placeholder="Message" returnKeyType="send" style={styles.input} value={draft} />
                <Pressable onPress={handleSend} style={({ pressed }) => [styles.sendButton, pressed && styles.pressed]}>
                    <Text style={styles.sendText}>Send</Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    author: { color: "#6b7280", fontSize: 12, marginBottom: 2 },
    bubble: { borderRadius: 12, marginVertical: 4, maxWidth: "80%", padding: 10 },
    bubbleMine: { alignSelf: "flex-end", backgroundColor: "#3b82f6" },
    bubbleTheirs: { alignSelf: "flex-start", backgroundColor: "#e5e7eb" },
    composer: { borderColor: "#e5e7eb", borderTopWidth: 1, flexDirection: "row", gap: 8, padding: 8 },
    dot: { borderRadius: 4, height: 8, width: 8 },
    flex: { flex: 1 },
    header: { alignItems: "center", borderBottomColor: "#e5e7eb", borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", padding: 12 },
    headerRight: { alignItems: "center", flexDirection: "row", gap: 8 },
    input: { borderColor: "#d1d5db", borderRadius: 20, borderWidth: 1, flex: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: 8 },
    listContent: { padding: 12 },
    pressed: { opacity: 0.85 },
    sendButton: { alignItems: "center", backgroundColor: "#3b82f6", borderRadius: 20, justifyContent: "center", paddingHorizontal: 18 },
    sendText: { color: "#fff", fontWeight: "600" },
    signOut: { color: "#3b82f6" },
    status: { color: "#6b7280", fontSize: 12 },
    textMine: { color: "#fff", fontSize: 16 },
    textTheirs: { color: "#111827", fontSize: 16 },
    title: { fontSize: 20, fontWeight: "700" },
});
