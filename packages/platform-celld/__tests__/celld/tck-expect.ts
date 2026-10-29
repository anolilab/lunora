/**
 * vitest's `expect` rebuilt for a runtime vitest does not run in.
 *
 * `@vitest/expect` is the Jest matcher set as a chai plugin — the same code
 * vitest's own `expect` is made of — so the suites assert with real matcher
 * semantics rather than a lookalike. What vitest adds on top, and what this
 * file reproduces, is the per-test assertion bookkeeping behind
 * `expect.assertions(n)` / `expect.hasAssertions()`; see vitest's
 * `createExpect`, which this mirrors minus snapshots, polling and soft asserts.
 */
import { chai, getState, JestAsymmetricMatchers, JestChaiExpect, JestExtend, setState } from "@vitest/expect";

type AssertionState = {
    assertionCalls: number;
    expectedAssertionsNumber: number | null;
    isExpectingAssertions: boolean;
};

type TestExpect = ((value: unknown, message?: string) => unknown) & {
    assertions: (expected: number) => void;
    hasAssertions: () => void;
};

/**
 * A fresh `expect` for one leg, plus the check vitest runs after the body.
 * @returns the `expect` to hand the leg, and `verify`, which throws when the
 * leg's declared assertion count was not met.
 */
const createLegExpect = (): { expect: TestExpect; verify: () => void } => {
    // Idempotent: chai remembers the plugins it has already applied.
    chai.use(JestExtend);
    chai.use(JestChaiExpect);
    chai.use(JestAsymmetricMatchers);

    const legExpect = ((value: unknown, message?: string) => {
        const state = getState(legExpect as never) as AssertionState;

        setState({ assertionCalls: state.assertionCalls + 1 }, legExpect as never);

        return chai.expect(value, message);
    }) as TestExpect;

    Object.assign(legExpect, chai.expect);
    setState({ assertionCalls: 0, expectedAssertionsNumber: null, isExpectingAssertions: false }, legExpect as never);
    legExpect.assertions = (expected) => {
        setState({ expectedAssertionsNumber: expected }, legExpect as never);
    };
    legExpect.hasAssertions = () => {
        setState({ isExpectingAssertions: true }, legExpect as never);
    };

    const verify = (): void => {
        const { assertionCalls, expectedAssertionsNumber, isExpectingAssertions } = getState(legExpect as never) as AssertionState;

        if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber) {
            throw new Error(`expected number of assertions to be ${String(expectedAssertionsNumber)}, but got ${String(assertionCalls)}`);
        }

        if (isExpectingAssertions && assertionCalls === 0) {
            throw new Error("expected any number of assertion, but got none");
        }
    };

    return { expect: legExpect, verify };
};

export { createLegExpect };
