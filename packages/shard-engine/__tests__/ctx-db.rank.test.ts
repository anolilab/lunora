import createSqliteExec from "./_helpers/node-sqlite";
import runRankScenarios from "./_scenarios/ctx-db.rank";

runRankScenarios(createSqliteExec);
