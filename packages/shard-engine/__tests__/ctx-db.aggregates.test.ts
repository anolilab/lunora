import createSqliteExec from "./_helpers/node-sqlite";
import runAggregateScenarios from "./_scenarios/ctx-db.aggregates";

runAggregateScenarios(createSqliteExec);
