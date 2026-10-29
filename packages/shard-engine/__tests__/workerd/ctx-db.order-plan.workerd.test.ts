import { aroundEach } from "vitest";

import runOrderPlanScenarios from "../_scenarios/ctx-db.order-plan";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runOrderPlanScenarios(createWorkerdExec);
