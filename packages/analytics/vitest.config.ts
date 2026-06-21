import { getVitestConfig } from "../../tools/get-vitest-config";

// Plain-Node suite: the write helper drives a structural fake dataset and the
// SQL-API client mocks `fetch` — neither needs workerd, so there is no
// `@cloudflare/vitest-pool-workers` project here (the sandbox can't run workerd
// anyway). Real-binding/live-API coverage would be CI-only via `skipIf(!CI)`.
export default getVitestConfig({ test: { environment: "node" } });
