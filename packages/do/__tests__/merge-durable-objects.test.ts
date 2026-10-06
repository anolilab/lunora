import { describe, expect, it } from "vitest";

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
        scheduler: recordingRole("scheduler"),
        shardRegistry: recordingRole("shardRegistry"),
        shard: recordingRole("shard"),
    });

    it.each([
        ["__root__", "shard:__root__"],
        ["user-42", "shard:user-42"],
        ["__lunora_do__:scheduler:default", "scheduler:__lunora_do__:scheduler:default"],
        ["__lunora_do__:shardRegistry:__lunora_shard_registry__", "shardRegistry:__lunora_do__:shardRegistry:__lunora_shard_registry__"],
    ])("routes instance %s to its role", async (name, expected) => {
        expect.assertions(1);

        const response = await new LunoraDO(stateNamed(name), {}).fetch(new Request("https://do.internal/"));

        await expect(response.text()).resolves.toBe(expected);
    });

    it("refuses a role the app did not merge in", () => {
        expect.assertions(1);

        const ShardOnly = mergeDurableObjects({ shard: recordingRole("shard") });

        expect(() => new ShardOnly(stateNamed("__lunora_do__:scheduler:default"), {})).toThrow(/names no role/u);
    });

    it("refuses an unknown or inherited role name rather than constructing it", () => {
        expect.assertions(2);

        // `constructor` is on every object's prototype; a lookup that reached it
        // would `new Object(state, env)` instead of failing.
        expect(() => new LunoraDO(stateNamed("__lunora_do__:constructor:x"), {})).toThrow(/names no role/u);
        expect(() => new LunoraDO(stateNamed("__lunora_do__:nope"), {})).toThrow(/names no role/u);
    });

    it("accepts the framework's own role classes", () => {
        expect.assertions(1);

        expect(mergeDurableObjects({ shard: recordingRole("shard"), shardRegistry: ShardRegistryDO })).toBeTypeOf("function");
    });
});

describe(roleNamespace, () => {
    /** A namespace double whose methods check their receiver, as workerd's native ones do. */
    interface FakeNamespace {
        get: (id: string) => string;
        getByName: (name: string) => string;
        idFromName: (name: string) => string;
        jurisdiction: (jurisdiction: string) => FakeNamespace;
    }

    const createNamespace = (seen: string[]): FakeNamespace => {
        const namespace: FakeNamespace = {
            get(id) {
                seen.push(`${this === namespace ? "bound" : "detached"} get:${id}`);

                return id;
            },
            getByName(name) {
                seen.push(`${this === namespace ? "bound" : "detached"} getByName:${name}`);

                return name;
            },
            idFromName(name) {
                seen.push(`${this === namespace ? "bound" : "detached"} id:${name}`);

                return name;
            },
            jurisdiction() {
                return namespace;
            },
        };

        return namespace;
    };

    it("prefixes every name it resolves, jurisdiction views included, and keeps the receiver", () => {
        expect.assertions(1);

        const seen: string[] = [];
        const scheduler = roleNamespace(createNamespace(seen), "scheduler");

        scheduler.getByName("default");
        scheduler.idFromName("default");
        scheduler.jurisdiction("eu").idFromName("nightly");
        // Members the framework does not name by pass through unprefixed.
        scheduler.get("opaque-id");

        expect(seen).toStrictEqual([
            "bound getByName:__lunora_do__:scheduler:default",
            "bound id:__lunora_do__:scheduler:default",
            "bound id:__lunora_do__:scheduler:nightly",
            "bound get:opaque-id",
        ]);
    });
});
