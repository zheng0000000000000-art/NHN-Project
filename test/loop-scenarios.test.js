import test from 'node:test';
import { scenarios, runScenario } from '../tools/verification/loop-scenarios.mjs';

for (const scenario of scenarios) {
  test(`loop scenario "${scenario.name}" executes repeatably without external mutation`, () => {
    runScenario(scenario);
  });
}
