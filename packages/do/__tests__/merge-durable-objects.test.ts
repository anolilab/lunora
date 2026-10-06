import { describe, expect, it } from "vitest";

import type { RoleNamespaceTarget } from "../src/merge-durable-objects";
import { mergeDurableObjects, roleNamespace } from "../src/merge-durable-objects";
import { ShardRegistryDO } from "../src/shard-registry-do";

/** A role class that records which instance it was built for. */
const recordingRole = (role: string) =>
    class {
        public readonly name: string | undefined;

        public constructor(state: DurableObjectState) {
            this.name = state.id.name;
        }

        public fetch(): Response {
            return new Response(`${role}:${String(this.name)}`);
        }
    };

const stateNamed = (name: string | undefined): DurableObjectState => ({ id: { name } }) as unknown as DurableObjectState;

describe(mergeDurableObjects, () => {
    const LunoraDO = mergeDurableObjects({
        registry: recordingRole("registry"),
        scheduler: recordingRole("scheduler"),
        shard: recordingRole("shard"),
    });

    it.each([
        ["__root__", "shard:__root__"],
        ["user-42", "shard:user-42"],
        ["__lunora_do__:scheduler:default", "scheduler:__lunora_do__:scheduler:default"],
        ["__lunora_do__:registry:__lunora_shard_registry__", "registry:__lunora_do__:registry:__lunora_shard_registry__"],
    ])("routes instance %s to its role", async (name, expected) => {
        expect.assertions(1);

        const response = await new LunoraDO(stateNamed(name), {}).fetch?.(new Request("https://do.internal/"));

        await expect(response?.text()).resolves.toBe(expected);
    });

    it("refuses a role the app did not merge in", () => {
        expect.assertions(1);

        const ShardOnly = mergeDurableObjects({ shard: recordingRole("shard") });

        expect(() => new ShardOnly(stateNamed("__lunora_do__:scheduler:default"), {})).toThrow(/no "scheduler" role/u);
    });

    it("accepts the framework's own role classes", () => {
        expect.assertions(1);

        expect(mergeDurableObjects({ registry: ShardRegistryDO, shard: recordingRole("shard") })).toBeTypeOf("function");
    });
});

describe(roleNamespace, () => {
    it("prefixes every name it resolves, jurisdiction views included", () => {
        expect.assertions(3);

        const seen: string[] = [];
        const namespace: RoleNamespaceTarget = {
            get: () => ({}) as DurableObjectStub,
            getByName(name: string) {
                // A detached call would lose `this`, as workerd's native methods do.
                seen.push(`${this === namespace ? "bound" : "detached"}:${name}`);

                return {} as DurableObjectStub;
            },
            idFromName: (name: string) => {
                seen.push(`id:${name}`);

                return {} as DurableObjectId;
            },
            jurisdiction: () => namespace,
        };
        const scheduler = roleNamespace(namespace, "scheduler");

        scheduler.getByName?.("default");
        scheduler.idFromName("default");
        scheduler.jurisdiction?.("eu").idFromName("nightly");

        expect(seen[0]).toBe("bound:__lunora_do__:scheduler:default");
        expect(seen[1]).toBe("id:__lunora_do__:scheduler:default");
        expect(seen[2]).toBe("id:__lunora_do__:scheduler:nightly");
    });
});
