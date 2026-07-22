import { getVitestConfig } from "../../tools/get-vitest-config";

// `@lunora/notify` is a thin adapter over `@visulima/notification` — `createNotify`
// builds a `Notification` facade from edge-safe providers (Web Push, FCM, chat,
// in-app, webhook) and threads a subscription store. Everything is tested in plain
// Node against structural provider/store fakes (a mock push provider, an in-memory
// store); no workerd pool is needed. Tests live under `__tests__/` and match
// vitest's default `*.test.ts`.
export default getVitestConfig({ test: { environment: "node" } });
