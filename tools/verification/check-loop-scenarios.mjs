import { scenarios, runScenario } from './loop-scenarios.mjs';

for (const scenario of scenarios) {
  runScenario(scenario);
}

process.stdout.write(
  `loop scenario regression passed (${scenarios.length} scenarios: ${scenarios.map((scenario) => scenario.name).join(', ')})\n`,
);
