import { join } from "node:path";

import { buildConfigSchema } from "#src/config-schema.ts";

const target = join(import.meta.dir, "..", "configuration_schema.json");
await Bun.write(target, `${JSON.stringify(buildConfigSchema(), null, 2)}\n`);
console.log(`Wrote ${target}`);
