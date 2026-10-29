import { aroundEach } from "vitest";

import runIssueStateScenarios from "../_scenarios/issue-state";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runIssueStateScenarios(createWorkerdExec);
