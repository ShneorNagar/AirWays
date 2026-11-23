import type { Env as AppEnvBindings } from "../../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnvBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
