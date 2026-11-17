import { aroundEach } from "vitest";

import runRequestLogScenarios from "../_scenarios/request-log";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runRequestLogScenarios(createWorkerdExec);
