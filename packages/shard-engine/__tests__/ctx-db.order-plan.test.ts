import createSqliteExec from "./_helpers/node-sqlite";
import runOrderPlanScenarios from "./_scenarios/ctx-db.order-plan";

runOrderPlanScenarios(createSqliteExec);
