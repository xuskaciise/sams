import { test, expect } from "@playwright/test";
import path from "node:path";

// Exercises the batch-code-autogen feature end to end: login as an admin,
// go to Academic Structure > Classes, create a class with program CMS +
// a fresh intake year, and confirm the auto-derived batch code and the
// composed row both show up.
//
// Uses a dedicated test account (playwright-test@sams.local) rather than
// a real admin's credentials — see the session notes for how it was
// created. Section is timestamp-suffixed so the run is repeatable without
// colliding with a previous run's class.

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

const CREDENTIALS = {
  identifier: "playwright-test@sams.local",
  password: "PlaywrightTest123!",
};

const PROGRAM_NAME = "COMPUTER SCEINCE"; // matches the seeded Program row's name exactly (note: typo is in the seed data itself)
const INTAKE_YEAR = "2026";
const EXPECTED_BATCH_CODE = "CMS26";
const SECTION = `T${Date.now().toString().slice(-4)}`;
const EXPECTED_CLASS_NAME = `${EXPECTED_BATCH_CODE}-${SECTION}-FT`;

test("admin creates a class and gets an auto-derived batch code", async ({
  page,
}) => {
  // --- Step 1: log in as ADMIN ---
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(CREDENTIALS.identifier);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The dev server may be under real concurrent load, so login can take a
  // while — this isn't a stale/hung-form condition, just slow.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30000 });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "01-login-dashboard.png"),
    fullPage: true,
  });

  // --- Step 2: navigate to Academic Structure > Classes ---
  await page.goto("/admin/structure?tab=classes");
  await expect(page.getByRole("heading", { name: "Classes" })).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "02-classes-page.png"),
    fullPage: true,
  });

  // --- Step 3: open "Add class" and fill the form ---
  await page.getByRole("button", { name: "Add class" }).click();
  await expect(page.getByRole("heading", { name: "Add class" })).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "03-add-class-dialog.png"),
    fullPage: true,
  });

  await page.getByRole("combobox", { name: "Program" }).click();
  await page.getByRole("option", { name: PROGRAM_NAME }).click();
  await page.getByLabel("Intake year").fill(INTAKE_YEAR);
  await page.getByLabel("Section").fill(SECTION);

  // Batch code is derived live, before study mode/submit — screenshot here
  // specifically to see the "Batch code: CMS26" preview in isolation.
  await expect(
    page.getByText(`Batch code: ${EXPECTED_BATCH_CODE}`)
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "04-batch-code-preview.png"),
    fullPage: true,
  });

  await page.getByRole("combobox", { name: "Study mode" }).click();
  await page.getByRole("option", { name: "Full-time" }).click();

  await expect(page.getByText(`Class name: ${EXPECTED_CLASS_NAME}`)).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "05-form-complete.png"),
    fullPage: true,
  });

  // --- Step 4: submit ---
  await page.getByRole("button", { name: "Create class" }).click();
  await expect(page.getByText("Class created.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Add class" })
  ).not.toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "06-after-create.png"),
    fullPage: true,
  });

  // --- Step 5: assert the new row appears in the table ---
  const row = page.getByRole("row", { name: new RegExp(EXPECTED_CLASS_NAME) });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell").nth(2)).toHaveText(EXPECTED_BATCH_CODE);
  await expect(row.getByRole("cell").nth(3)).toHaveText(SECTION);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "07-new-row-in-table.png"),
    fullPage: true,
  });
});
