import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const scenariosDir = join(process.cwd(), "tests", "scenarios");

function validateScenario(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  const required = ["id", "seed", "fixedDeltaMs", "resolution", "totalFrames"];
  for (const key of required) {
    if (!(key in parsed)) {
      throw new Error(`Scenario ${filePath} missing required key: ${key}`);
    }
  }

  if (typeof parsed.seed !== "number") {
    throw new Error(`Scenario ${filePath} must use numeric seed.`);
  }

  if (typeof parsed.fixedDeltaMs !== "number" || parsed.fixedDeltaMs <= 0) {
    throw new Error(`Scenario ${filePath} fixedDeltaMs must be > 0.`);
  }
}

try {
  const files = readdirSync(scenariosDir).filter((name) => name.endsWith(".json"));
  if (files.length === 0) {
    throw new Error("No scenario files found.");
  }

  for (const file of files) {
    validateScenario(join(scenariosDir, file));
  }

  console.log(`Validated ${files.length} scenario file(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
