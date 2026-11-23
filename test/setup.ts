// Preloaded by `bun test` (see bunfig.toml): hooks here run once for the whole run, not per file.
import { afterAll } from "bun:test";

import { removeTempProjects } from "./helpers.ts";

afterAll(removeTempProjects);
