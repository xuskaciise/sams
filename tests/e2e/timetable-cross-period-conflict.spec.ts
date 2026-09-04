import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Regression: adding a slot with the "Allow cross-period shift" option that
// clashes with an existing booking used to surface a dead-end generic error
// ("Something went wrong" toast + a redacted "An error occurred in the
// Server Components render… digest…" in production) instead of the real
// conflict reason.
//
// Cross-period placements land on a time the OTHER period's sessions
// usually already own, so they conflict often; and the user typically
// clicks "Create slot" before the debounced live conflict preview has
// resolved. onSubmit now PREFLIGHTS the same server-side conflict check
// (which returns conflicts as data, never redacted) before the write, so
// the clash is shown inline + as a clear toast and no unhandled/redacted
// error is produced.
//
// Uses the shared Playwright test admin (see create-class.spec.ts).

const CRED = {
  identifier: "playwright-test@sams.local",
  password: "PlaywrightTest123!",
};

// An FT class with a Morning period + a course assignment on it, plus an
// Afternoon ("Galab") shift — i.e. cross-period for this class. These are
// stable seed rows.
const ASSIGNMENT_SEARCH = "Discrete Mathematics";
const ASSIGNMENT_OPTION = /Discrete Mathematics.*4A-FT/;
const CROSS_PERIOD_SHIFT_SEARCH = "Galab 2"; // Afternoon shift, 14:30–16:00

const prisma = new PrismaClient();

test.afterAll(async () => {
  // Remove whatever this spec created so the shared dev DB stays clean and
  // the test is repeatable.
  await prisma.timetableSlot.deleteMany({ where: { crossPeriodOverride: true } });
  await prisma.$disconnect();
});

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(CRED.identifier);
  await page.getByLabel("Password").fill(CRED.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 40000 });
}

async function fillCrossPeriodSlotForm(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Add slot" }).click();
  await expect(
    page.getByRole("heading", { name: "Add timetable slot" })
  ).toBeVisible();

  await page.getByRole("button", { name: /Select a course assignment/ }).click();
  await page.getByPlaceholder("Search assignments…").fill(ASSIGNMENT_SEARCH);
  await page.getByRole("option", { name: ASSIGNMENT_OPTION }).first().click();

  await page.getByRole("checkbox", { name: /Allow cross-period shift/ }).click();

  await page.getByRole("combobox", { name: "Day" }).click();
  await page.getByRole("option", { name: "Tuesday" }).click();

  await page.getByRole("button", { name: /No shift — custom time/ }).click();
  await page.getByPlaceholder("Search shifts…").fill(CROSS_PERIOD_SHIFT_SEARCH);
  await page.getByRole("option").first().click();
  // The picked cross-period shift fills the (13:00–14:30 style) times.
  await expect(page.locator("input[type=time]").first()).not.toHaveValue("");
}

test("cross-period slot: first add succeeds, a conflicting add shows the real reason (no redacted crash)", async ({
  page,
}) => {
  // The shared dev server runs actions serially and slowly (login + two
  // full form round-trips + two writes) — well past the 60s project default.
  test.setTimeout(240_000);

  const pageErrors: string[] = [];
  const badConsole: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.stack || e)));
  page.on("console", (m) => {
    const t = m.text();
    if (/Server Components render|digest property|Internal Server Error/i.test(t)) {
      badConsole.push(`[${m.type()}] ${t}`);
    }
  });

  await login(page);
  await page.goto("/admin/timetable");
  await expect(page.getByRole("heading", { name: "Timetable" })).toBeVisible({
    timeout: 30000,
  });

  // --- 1. The cross-period slot itself creates fine (happy path unbroken).
  //        Assert on the dialog closing rather than the (auto-dismissing)
  //        success toast. ---
  await fillCrossPeriodSlotForm(page);
  await page.getByRole("button", { name: "Create slot" }).click();
  await expect(
    page.getByRole("heading", { name: "Add timetable slot" })
  ).not.toBeVisible({ timeout: 40000 });
  expect(
    await prisma.timetableSlot.count({ where: { crossPeriodOverride: true } })
  ).toBe(1);

  // --- 2. Adding the SAME cross-period slot again -> room+lecturer+class
  //        clash. It must be reported clearly, not as a generic dead end. ---
  await fillCrossPeriodSlotForm(page);
  await page.getByRole("button", { name: "Create slot" }).click();

  const conflictPanel = page.getByText("This slot conflicts with existing bookings");
  await expect(conflictPanel).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText(/Room .* is already booked for Discrete Mathematics/)
  ).toBeVisible();
  await expect(
    page.getByText(/a lecturer can't teach two classes at the same time/)
  ).toBeVisible();
  await expect(
    page.getByText(/a class can't have two sessions at once/)
  ).toBeVisible();

  // The generic dead-end message must NOT appear.
  await expect(page.getByText("Something went wrong. Please try again.")).toHaveCount(0);

  // The dialog stays open so the admin can fix the clash.
  await expect(
    page.getByRole("heading", { name: "Add timetable slot" })
  ).toBeVisible();

  expect(pageErrors, "no unhandled page errors").toEqual([]);
  expect(
    badConsole,
    "no redacted 'Server Components render' / 500 error on the conflict path"
  ).toEqual([]);
});
