import createSqliteExec from "./_helpers/node-sqlite";
import runIssueStateScenarios from "./_scenarios/issue-state";

runIssueStateScenarios(createSqliteExec);
