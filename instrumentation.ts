// Runs once when the Next.js server process starts. Starts the in-process
// scheduler for lecturer Google Drive backups (lib/drive-backup.ts) — the
// debounced 5-minute trigger and the daily safety net both run from it.
// Node runtime only; a no-op when Google OAuth isn't configured.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startDriveBackupScheduler } = await import("@/lib/drive-backup");
  startDriveBackupScheduler();
}
