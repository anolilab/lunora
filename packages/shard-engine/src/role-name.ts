/**
 * The instance-name prefix reserved for framework roles that share the shard
 * namespace when an app merges its Durable Object classes (plan 462): the
 * scheduler lives at `__lunora_do__:scheduler:<name>`, the shard registry at
 * `__lunora_do__:registry:<name>`. A shard key can never carry it — the runtime
 * rejects one — so a client cannot reach those roles through a shard route.
 */
const LUNORA_ROLE_PREFIX = "__lunora_do__:";

export default LUNORA_ROLE_PREFIX;
