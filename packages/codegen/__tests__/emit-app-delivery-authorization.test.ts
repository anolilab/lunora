import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

describe("emitApp — delivery authorization", () => {
    it("emits the builder method and its createShardDO plumbing by default", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).toMatch(
            /public deliveryAuthorization\(selector: \(env: Env\) => ReturnType<NonNullable<ShardConfig\["deliveryAuthorization"\]>>\): this \{/,
        );
        expect(output).toContain("...(this.deliveryAuthorizationSelector === undefined ? {} : { deliveryAuthorization: this.deliveryAuthorizationSelector }),");
    });

    it("withholds the field, the method and the config spread when the target cannot back it", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasDeliveryAuthorization: false });

        expect(output).not.toContain("deliveryAuthorizationSelector");
        expect(output).not.toContain("public deliveryAuthorization(");
        expect(output).not.toContain("deliveryAuthorization: this.");
    });
});
