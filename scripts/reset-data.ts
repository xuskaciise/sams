/**
 * ONE-OFF, MANUAL-ONLY production-cutover cleanup script.
 *
 * NEVER imported by the app — not from any Server Action, page, or API
 * route. The only way to run this is directly from a terminal:
 *
 *   npx tsx scripts/reset-data.ts                       # dry run (default — no writes, ever, unless --confirm is present)
 *   npx tsx scripts/reset-data.ts --confirm --i-have-a-backup [decision flags below]
 *
 * SAFETY — READ THIS BEFORE PASSING --confirm:
 *   1. Create a Neon backup branch (Neon console -> your project -> Branches
 *      -> "New branch" from `main` at "now", or `npx neonctl branches create
 *      --project-id <id> --parent main --name pre-reset-backup` if neonctl
 *      is authenticated) BEFORE running with --confirm. This script does
 *      NOT create that backup for you and will refuse to run destructively
 *      without --i-have-a-backup as an explicit acknowledgement.
 *   2. Run WITHOUT --confirm first (or with no flags at all) and read the
 *      full report. Nothing is deleted until --confirm is also present.
 *   3. Decision flags below default to the MOST CONSERVATIVE option (keep
 *      data) — you must opt IN to wiping classes / campuses+rooms /
 *      departments+programs / dean_departments / pruning specific staff.
 *
 * Decision flags (all optional, all default to "keep"):
 *   --keep-users=<id,id,...>        Keep ONLY these User ids among current
 *                                   ADMIN/DEAN/LECTURER accounts, delete the
 *                                   rest (and their Lecturer profiles).
 *                                   Omit entirely to keep ALL of them
 *                                   (the default and safest option).
 *   --wipe-classes                  Delete Class rows (and Student rows,
 *                                   which are always deleted regardless —
 *                                   see below) instead of keeping them.
 *   --wipe-campuses-rooms           Delete Campus/Room rows instead of
 *                                   keeping them. If classes are KEPT while
 *                                   rooms are wiped, those classes'
 *                                   Class.roomId is set to NULL by the DB's
 *                                   own ON DELETE SET NULL constraint —
 *                                   they simply lose their default room.
 *   --wipe-departments-programs     Delete Department/Program rows.
 *                                   REQUIRES --wipe-classes too (a Class
 *                                   always needs a valid Program) — the
 *                                   script refuses to run otherwise. This
 *                                   ALSO cascade-deletes dean_departments
 *                                   rows for the wiped departments (a DB-
 *                                   level ON DELETE CASCADE on
 *                                   DeanDepartment.departmentId) even if
 *                                   --wipe-dean-departments was not passed —
 *                                   flagged loudly in the report either way.
 *   --wipe-dean-departments         Delete ALL dean_departments rows
 *                                   (faculty assignments) even for
 *                                   departments that are otherwise kept.
 *
 * Always deleted, unconditionally (no flag — see CLAUDE.md's cutover
 * cleanup checklist for why each of these is safe to always wipe):
 *   whatsapp_notification_logs, result_corrections, assessment_results,
 *   group_members, student_groups, assessments, ownership_transfers,
 *   timetable_slots, student_course_enrollments,
 *   lecturer_course_assignments, class_course_plans, students (+ their
 *   User accounts), courses, semesters, academic_years, daily_log_entries,
 *   sessions (everyone re-logs-in). assessment_types is reset to the
 *   seeded default 6 (Quiz/Assignment/Lab/Presentation/Project/Class
 *   Work) — anything else is deleted. audit_logs keeps its 50 most recent
 *   rows, deletes everything older.
 *
 * Always KEPT, never touched by this script under any flag combination:
 *   roles, permissions, role_permissions, user_roles,
 *   user_permission_overrides, shifts, whatsapp_settings,
 *   whatsapp_message_templates.
 */
import { prisma } from "../lib/db";

const RESET_TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 15_000 };

const DEFAULT_ASSESSMENT_TYPES = [
  "Quiz",
  "Assignment",
  "Lab",
  "Presentation",
  "Project",
  "Class Work",
];

interface Flags {
  confirm: boolean;
  iHaveABackup: boolean;
  keepUserIds: string[] | null; // null = keep ALL current staff
  wipeClasses: boolean;
  wipeCampusesRooms: boolean;
  wipeDepartmentsPrograms: boolean;
  wipeDeanDepartments: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const has = (name: string) => argv.includes(`--${name}`);

  const keepUsersRaw = get("keep-users");
  return {
    confirm: has("confirm"),
    iHaveABackup: has("i-have-a-backup"),
    keepUserIds: keepUsersRaw ? keepUsersRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
    wipeClasses: has("wipe-classes"),
    wipeCampusesRooms: has("wipe-campuses-rooms"),
    wipeDepartmentsPrograms: has("wipe-departments-programs"),
    wipeDeanDepartments: has("wipe-dean-departments"),
  };
}

function section(title: string) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

async function getStaffToKeepAndDelete(keepUserIds: string[] | null) {
  const staff = await prisma.user.findMany({
    where: {
      userRoles: { some: { role: { name: { in: ["ADMIN", "DEAN", "LECTURER"] } } } },
    },
    include: {
      userRoles: { include: { role: true } },
      lecturerProfile: true,
    },
    orderBy: { email: "asc" },
  });

  if (keepUserIds === null) {
    return { toKeep: staff, toDelete: [] as typeof staff };
  }
  const keepSet = new Set(keepUserIds);
  return {
    toKeep: staff.filter((u) => keepSet.has(u.id)),
    toDelete: staff.filter((u) => !keepSet.has(u.id)),
  };
}

async function buildReport(flags: Flags) {
  const { toKeep, toDelete } = await getStaffToKeepAndDelete(flags.keepUserIds);

  const counts: Record<string, number> = {
    whatsapp_notification_logs: await prisma.whatsAppNotificationLog.count(),
    result_corrections: await prisma.resultCorrection.count(),
    assessment_results: await prisma.assessmentResult.count(),
    group_members: await prisma.groupMember.count(),
    student_groups: await prisma.studentGroup.count(),
    assessments: await prisma.assessment.count(),
    ownership_transfers: await prisma.ownershipTransfer.count(),
    timetable_slots: await prisma.timetableSlot.count(),
    student_course_enrollments: await prisma.studentCourseEnrollment.count(),
    lecturer_course_assignments: await prisma.lecturerCourseAssignment.count(),
    class_course_plans: await prisma.classCoursePlan.count(),
    students: await prisma.student.count(),
    courses: await prisma.course.count(),
    semesters: await prisma.semester.count(),
    academic_years: await prisma.academicYear.count(),
    daily_log_entries: await prisma.dailyLogEntry.count(),
    sessions: await prisma.session.count(),
    audit_logs_total: await prisma.auditLog.count(),
  };
  const auditLogsToDelete = Math.max(0, counts.audit_logs_total - 50);

  const assessmentTypesAll = await prisma.assessmentType.findMany({ select: { name: true } });
  const assessmentTypesToDelete = assessmentTypesAll
    .map((t) => t.name)
    .filter((name) => !DEFAULT_ASSESSMENT_TYPES.includes(name));

  const classesCount = await prisma.class.count();
  const campusesCount = await prisma.campus.count();
  const roomsCount = await prisma.room.count();
  const departmentsCount = await prisma.department.count();
  const programsCount = await prisma.program.count();
  const deanDepartmentsCount = await prisma.deanDepartment.count();
  const shiftsCount = await prisma.shift.count();

  section("DRY RUN — unconditional deletions (always happen)");
  for (const [table, count] of Object.entries(counts)) {
    if (table === "audit_logs_total") continue;
    console.log(`  ${table.padEnd(32)} ${count}`);
  }
  console.log(`  ${"audit_logs (total / to delete / kept)".padEnd(32)} ${counts.audit_logs_total} / ${auditLogsToDelete} / ${Math.min(50, counts.audit_logs_total)}`);
  console.log(`  ${"assessment_types (extra, to delete)".padEnd(32)} ${assessmentTypesToDelete.length}${assessmentTypesToDelete.length ? " -> " + assessmentTypesToDelete.join(", ") : ""}`);
  console.log(`  ${"students' user accounts".padEnd(32)} ${await prisma.user.count({ where: { studentProfile: { isNot: null } } })}`);

  section("STAFF ACCOUNTS (ADMIN/DEAN/LECTURER) — review before deciding");
  console.log(`  KEEP (${toKeep.length}):`);
  for (const u of toKeep) {
    const roles = u.userRoles.map((ur) => ur.role.name).join(", ");
    console.log(`    - ${u.email} (${u.fullName}) [${roles}]${u.lecturerProfile ? ` staffNo=${u.lecturerProfile.staffNo}` : ""}`);
  }
  if (toDelete.length > 0) {
    console.log(`  DELETE (${toDelete.length}) — because --keep-users omitted them:`);
    for (const u of toDelete) {
      const roles = u.userRoles.map((ur) => ur.role.name).join(", ");
      console.log(`    - ${u.email} (${u.fullName}) [${roles}]`);
    }
  } else {
    console.log(`  DELETE: none (default — --keep-users was not passed, so ALL current staff are kept)`);
  }

  section("CONDITIONAL — depends on your decisions");
  console.log(`  classes:              ${classesCount}${flags.wipeClasses ? "  -> WILL BE DELETED" : "  -> kept (pass --wipe-classes to delete)"}`);
  console.log(`  campuses:             ${campusesCount}${flags.wipeCampusesRooms ? "  -> WILL BE DELETED" : "  -> kept (pass --wipe-campuses-rooms to delete)"}`);
  console.log(`  rooms:                ${roomsCount}${flags.wipeCampusesRooms ? "  -> WILL BE DELETED" : "  -> kept (pass --wipe-campuses-rooms to delete)"}`);
  console.log(`  departments:          ${departmentsCount}${flags.wipeDepartmentsPrograms ? "  -> WILL BE DELETED" : "  -> kept (pass --wipe-departments-programs to delete)"}`);
  console.log(`  programs:             ${programsCount}${flags.wipeDepartmentsPrograms ? "  -> WILL BE DELETED" : "  -> kept (pass --wipe-departments-programs to delete)"}`);
  console.log(`  dean_departments:     ${deanDepartmentsCount}${flags.wipeDeanDepartments || flags.wipeDepartmentsPrograms ? "  -> WILL BE DELETED" : "  -> kept"}`);

  section("NEVER TOUCHED (no flag can delete these)");
  console.log(`  roles, permissions, role_permissions, user_roles, user_permission_overrides`);
  console.log(`  shifts: ${shiftsCount} kept`);
  console.log(`  whatsapp_settings, whatsapp_message_templates: kept`);

  if (flags.wipeDepartmentsPrograms && !flags.wipeClasses) {
    section("BLOCKED");
    console.log(
      "  --wipe-departments-programs requires --wipe-classes too (a Class always needs a\n" +
        "  valid Program — there is no way to keep classes while deleting the programs they\n" +
        "  point to). Re-run with both flags, or drop --wipe-departments-programs."
    );
  }
  if (flags.wipeDepartmentsPrograms && !flags.wipeDeanDepartments) {
    console.log(
      "\n  NOTE: dean_departments has ON DELETE CASCADE on department_id — wiping departments\n" +
        "  will delete dean_departments rows for them regardless of --wipe-dean-departments."
    );
  }
  if (flags.wipeCampusesRooms && !flags.wipeClasses) {
    console.log(
      "\n  NOTE: kept classes whose roomId pointed at a deleted room will have roomId set to\n" +
        "  NULL automatically (ON DELETE SET NULL) — they'll show as \"Not set\" afterward."
    );
  }

  return { toKeep, toDelete, blocked: flags.wipeDepartmentsPrograms && !flags.wipeClasses };
}

async function performDeletion(flags: Flags, toDelete: { id: string }[]) {
  await prisma.$transaction(async (tx) => {
    // 1. Fully independent / leaf tables — safe to delete first, any order.
    await tx.whatsAppNotificationLog.deleteMany();
    await tx.resultCorrection.deleteMany();
    await tx.assessmentResult.deleteMany();
    await tx.groupMember.deleteMany();
    await tx.studentGroup.deleteMany();
    await tx.ownershipTransfer.deleteMany();
    await tx.assessment.deleteMany();
    await tx.timetableSlot.deleteMany();
    await tx.studentCourseEnrollment.deleteMany();
    await tx.lecturerCourseAssignment.deleteMany();
    await tx.classCoursePlan.deleteMany();
    await tx.dailyLogEntry.deleteMany();

    // 2. Students + their (student-only) User accounts.
    const studentUserIds = (
      await tx.student.findMany({ where: { userId: { not: null } }, select: { userId: true } })
    ).map((s) => s.userId!);
    await tx.student.deleteMany();
    if (studentUserIds.length > 0) {
      await tx.user.deleteMany({ where: { id: { in: studentUserIds } } });
    }

    // 3. Conditional: classes (and, if wiping departments/programs, always
    // wiped together per the hard dependency checked before this runs).
    if (flags.wipeClasses || flags.wipeDepartmentsPrograms) {
      await tx.class.deleteMany();
    }

    // 4. Courses / semesters / academic years — always wiped.
    await tx.course.deleteMany();
    await tx.semester.deleteMany();
    await tx.academicYear.deleteMany();

    // 5. Conditional: departments/programs (classes already gone by now).
    if (flags.wipeDepartmentsPrograms) {
      await tx.program.deleteMany();
      await tx.department.deleteMany(); // cascades dean_departments for these
    } else if (flags.wipeDeanDepartments) {
      await tx.deanDepartment.deleteMany();
    }

    // 6. Conditional: campuses/rooms (Class.roomId SET NULL automatically
    // for any kept class pointing at a deleted room).
    if (flags.wipeCampusesRooms) {
      await tx.room.deleteMany();
      await tx.campus.deleteMany();
    }

    // 7. Staff pruning — Lecturer profile before its User row (Lecturer.userId
    // has no cascade), everything else (Session/UserRole/UserPermissionOverride/
    // DeanDepartment) cascades automatically.
    if (toDelete.length > 0) {
      const ids = toDelete.map((u) => u.id);
      await tx.lecturer.deleteMany({ where: { userId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    }

    // 8. assessment_types back to defaults.
    await tx.assessmentType.deleteMany({ where: { name: { notIn: DEFAULT_ASSESSMENT_TYPES } } });
    for (const name of DEFAULT_ASSESSMENT_TYPES) {
      await tx.assessmentType.upsert({ where: { name }, update: {}, create: { name } });
    }

    // 9. Sessions — everyone re-logs-in, including kept staff.
    await tx.session.deleteMany();

    // 10. Audit logs — keep the 50 most recent, delete the rest.
    const recent = await tx.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true },
    });
    await tx.auditLog.deleteMany({ where: { id: { notIn: recent.map((r) => r.id) } } });
  }, RESET_TRANSACTION_OPTIONS);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  console.log("SAMS production-cutover data reset — scripts/reset-data.ts");
  console.log(flags.confirm ? "MODE: --confirm passed — this WILL delete data if the report below isn't blocked." : "MODE: dry run (no --confirm) — nothing will be written.");

  const { toDelete, blocked } = await buildReport(flags);

  if (!flags.confirm) {
    section("Dry run complete — no changes made");
    console.log("  Re-run with --confirm (plus --i-have-a-backup and any decision flags) to execute.");
    return;
  }

  if (blocked) {
    section("REFUSING TO RUN — see BLOCKED section above");
    process.exitCode = 1;
    return;
  }

  if (!flags.iHaveABackup) {
    section("REFUSING TO RUN");
    console.log("  --confirm was passed without --i-have-a-backup.");
    console.log("  Create a Neon backup branch first, then re-run with both flags.");
    process.exitCode = 1;
    return;
  }

  section("EXECUTING DELETION");
  await performDeletion(flags, toDelete);
  console.log("Done.");

  section("POST-DELETION COUNTS");
  await buildReport(flags);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
