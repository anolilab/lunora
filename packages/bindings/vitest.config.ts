import { getVitestConfig } from "../../tools/get-vitest-config";

// All six binding helpers (kv / images / analytics / pipelines / vectors / r2sql) are thin
// facades over their Cloudflare binding, tested in plain Node against structural
// fakes — none needs a workerd pool. Tests live under `__tests__/<binding>/` and
// match vitest's default `*.test.ts` glob.
export default getVitestConfig({ test: { environment: "node" } });
