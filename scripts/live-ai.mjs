import { spawnSync } from 'node:child_process';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY before running the live test.');
  process.exitCode = 1;
} else {
  const test = spawnSync(process.execPath,['--test','--test-name-pattern','real OpenAI Responses API'],{
    stdio:'inherit', env:{...process.env,RELAY_TEST_LIVE_AI:'1'}
  });
  process.exitCode = test.status ?? 1;
}
