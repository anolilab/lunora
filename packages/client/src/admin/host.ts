/** The two client operations an admin call needs. The client supplies them as late-bound calls. */
export interface AdminHost {
    adminFetch: (
        path: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        payload?: ArrayBuffer | Blob | Record<string, unknown>,
        contentType?: string,
    ) => Promise<unknown>;
    assertOpen: () => void;
}
