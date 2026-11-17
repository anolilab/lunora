import createSqliteExec from "./_helpers/node-sqlite";
import runBoundedFindManyDoScenarios from "./_scenarios/ctx-db.bounded-find-many";

runBoundedFindManyDoScenarios(createSqliteExec);
