/**
 * A whole build, both halves back to back — what a build runner does across its
 * two alarms (`src/builds/runner-do.ts`), for the tests that follow one build's
 * lifecycle through the runner ports.
 */
import type { BuildOutcome, BuildRunnerPorts, ClaimedBuild } from "../../src/builds/runner";
import { executeBuild, finishBuild } from "../../src/builds/runner";

const runBuild = async (build: ClaimedBuild, ports: BuildRunnerPorts): Promise<BuildOutcome> => {
    const executed = await executeBuild(build, ports);

    return "outcome" in executed ? executed.outcome : finishBuild(build, executed.execution, ports);
};

export default runBuild;
