import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: these are node-side tests for the
// server store seam and the scanner maths. They must not pull in the React or
// Tailwind plugins, and they must not inherit the dev-server proxy config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Fixtures are data, not suites.
    exclude: ["tests/fixtures/**", "node_modules/**", "dist/**"],
  },
});
