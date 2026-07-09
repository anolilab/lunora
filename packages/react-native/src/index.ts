export { createLunoraClient } from "./create-lunora-client";
export type { AuthHeadersFactory, CreateLunoraClientOptions } from "./types";
// `@lunora/react-native` is the React Native / Expo entry to Lunora. The hooks,
// provider, and auth gates are the exact same client-side React building blocks
// as `@lunora/react` — they call `useState`/`useEffect`/`use(...)` and own a
// live WebSocket, and they never touch `react-dom` or a browser-only global — so
// they run unchanged under React Native. Rather than fork them, this package
// re-exports the whole `@lunora/react` surface and adds the two things a native
// app needs on top: a React-Native-tuned client factory (AsyncStorage-backed
// offline queue + credentialed fetch/WebSocket) and, from the `./auth` subpath,
// a one-call better-auth Expo client.
export * from "@lunora/react";
