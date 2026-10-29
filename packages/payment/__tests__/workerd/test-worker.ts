/**
 * Test entry-point Worker for the payment store's workerd suites.
 *
 * {@link PaymentStoreDO} is a bare SQLite-backed Durable Object: the suites drive
 * it with `runInDurableObject` and build the store inside it over a real
 * shard-engine `ctx.db`, which is what the generated
 * ShardDO hands `paymentsFromContext`.
 */
import { DurableObject } from "cloudflare:workers";

interface TestEnv {
    PAYMENT_DO: DurableObjectNamespace<PaymentStoreDO>;
}

class PaymentStoreDO extends DurableObject<TestEnv> {}

const testWorker = {
    fetch: (): Response => new Response("lunora-payment-test-worker"),
};

export default testWorker;
export type { TestEnv };
export { PaymentStoreDO };
