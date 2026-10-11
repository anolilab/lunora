/**
 * The two client operations an admin call needs. The client supplies them as late-bound calls.
 *
 * The module signatures take their types from `LunoraClient` via `Parameters` and `ReturnType`.
 * Every class method those types read must keep an explicit return annotation: without one the
 * derived type is circular, and it silently widens if the method is overloaded later.
 */
export interface AdminHost {
    adminFetch: (
        path: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        payload?: ArrayBuffer | Blob | Record<string, unknown>,
        contentType?: string,
    ) => Promise<unknown>;
    assertOpen: () => void;
}
