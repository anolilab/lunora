/**
 * The shape of `halt-stub.generated.js`, which `vitest.config.ts` writes from
 * `halt-stub-fixture.ts` with `buildHaltStub` before the `workerd` project
 * boots — so the type checker has it whether or not that project ever ran.
 */
import type { DurableObject } from "cloudflare:workers";

export declare class ParkedSqlite extends DurableObject {}

export declare class ParkedKv extends DurableObject {}

declare const worker: { fetch: (request: Request) => Response };

export default worker;
