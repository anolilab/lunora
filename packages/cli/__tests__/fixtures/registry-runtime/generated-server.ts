/**
 * Runtime stand-in for `#lunora/_generated/server.js` — the module codegen emits
 * into a real project, which does not exist inside this package.
 *
 * `registry/tsconfig.json` already TYPE-checks the shipped items against
 * `registry/lunora-generated-server.d.ts`; that stub is declarations only, so
 * nothing can RUN an item. This one is the runtime half: the builders are the
 * identity, so `internalAction.input(…).action(handler)` evaluates to `handler`
 * and a test can invoke it directly with its own `{ args, ctx }`.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */

interface Builder {
    action: (handler: unknown) => unknown;
    input: (schema: unknown) => Builder;
}

const builder = (): Builder => {
    return {
        action: (handler) => handler,
        input: () => builder(),
    };
};

/** Chainable no-op validator: the items only ever build these, never run them. */
interface ValidatorStub {
    max: (limit: number) => ValidatorStub;
}

const validator = (): ValidatorStub => {
    const self: ValidatorStub = { max: () => self };

    return self;
};

const v = {
    array: (): ValidatorStub => validator(),
    number: (): ValidatorStub => validator(),
    optional: (): ValidatorStub => validator(),
    record: (): ValidatorStub => validator(),
    string: (): ValidatorStub => validator(),
};

const action = builder();
const internalAction = builder();
const internalMutation = builder();
const mutation = builder();
const query = builder();

export { action, internalAction, internalMutation, mutation, query, v };
