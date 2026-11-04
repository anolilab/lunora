import { aroundEach } from "vitest";

import runBoundedFindManyDoScenarios from "../_scenarios/ctx-db.bounded-find-many";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runBoundedFindManyDoScenarios(createWorkerdExec);
