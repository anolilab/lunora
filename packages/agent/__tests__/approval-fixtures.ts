/**
 * The approval marker the loop writes, for tests that seed one directly. The
 * inbox hides a marker without a future `expiresAt`, so every fixture takes its
 * deadline from here: a test that forgets it fails on the empty list instead of
 * passing for the wrong reason.
 */
const approvalMarkerFields = (marker: {
    expiresAt?: number;
    instanceId: string;
    messageKey?: string;
    toolCallId: string;
}): Record<string, unknown> & { expiresAt: number; messageKey: string } => {
    return {
        content: `Awaiting approval to run tool "refund".`,
        expiresAt: marker.expiresAt ?? Date.now() + 60_000,
        messageKey: marker.messageKey ?? `${marker.instanceId}:approval:${marker.toolCallId}`,
        role: "tool",
        status: "awaiting_approval",
        toolCallId: marker.toolCallId,
        toolName: "refund",
    };
};

export default approvalMarkerFields;
