import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Fork: keep tests from reading the developer's real ~/.pi/remote/config.json
// (for example `auto_start_everywhere`).
export default defineConfig({
  test: {
    env: { HOME: mkdtempSync(join(tmpdir(), "remote-pi-test-home-")) },
  },
});
