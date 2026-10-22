import { aroundEach } from "vitest";

import runRankScenarios from "../_scenarios/ctx-db.rank";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runRankScenarios(createWorkerdExec);
