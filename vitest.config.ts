import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/tests/**/*.test.{ts,tsx}"],
    setupFiles: ["web/tests/setup.ts"],
    restoreMocks: true,
  },
});
