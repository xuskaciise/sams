import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  reporter: [["list"]],
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "off", // steps take their own named screenshots explicitly
    trace: "retain-on-failure",
    actionTimeout: 20000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
