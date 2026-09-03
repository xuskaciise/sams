import { prisma } from "@/lib/db";
import { fillTemplate } from "@/lib/whatsapp-templates";
import {
  getEffectiveAutomaticEmail,
  WHATSAPP_SETTINGS_ID,
} from "@/lib/whatsapp-notify";
import { sendEmail } from "@/lib/email";

// Automatic EMAIL notifications for students. Both functions are
// FIRE-AND-FORGET — wrapped in try/catch, never throw — so a bad address
// or a provider outage can never block account generation or result
// publishing. Wording (subject + body) is the admin-editable
// STUDENT_LOGIN_CREDENTIALS_EMAIL / RESULTS_PUBLISHED_EMAIL template.

async function resolveDomainName(): Promise<string> {
  const settings = await prisma.whatsAppSettings.findUnique({
    where: { id: WHATSAPP_SETTINGS_ID },
  });
  return settings?.domainName ?? "";
}

export interface StudentCredentialEmailParams {
  studentId: string;
  studentNo: string;
  fullName: string;
  email: string | null; // the student's REAL email (null -> nothing sent)
  username: string; // == studentNo for students
  tempPassword: string;
}

// Sent (if the student has a real email) right after their account is
// generated — carries the one-time password. No email on file =>
// { sent: false }, and the existing CSV / one-time on-screen reveal is the
// admin's fallback.
export async function emailStudentCredentials(
  params: StudentCredentialEmailParams
): Promise<{ sent: boolean }> {
  try {
    if (!params.email) return { sent: false };
    const [{ subject, body }, domainName] = await Promise.all([
      getEffectiveAutomaticEmail("STUDENT_LOGIN_CREDENTIALS_EMAIL"),
      resolveDomainName(),
    ]);
    const vars = {
      studentName: params.fullName,
      studentNo: params.studentNo,
      username: params.username,
      tempPassword: params.tempPassword,
      domainName,
    };
    return await sendEmail({
      to: params.email,
      subject: fillTemplate(subject, vars),
      text: fillTemplate(body, vars),
      log: {
        recipientType: "STUDENT",
        recipientId: params.studentId,
        eventKey: "STUDENT_LOGIN_CREDENTIALS_EMAIL",
        entity: "Student",
        entityId: params.studentId,
      },
    });
  } catch (error) {
    console.error("[email-notify] emailStudentCredentials failed", error);
    return { sent: false };
  }
}

// Fired alongside the WhatsApp RESULTS_PUBLISHED hook when a lecturer
// publishes. Emails every affected student who has a real email on file —
// deliberately WITHOUT the mark (privacy); directs them to log in.
export async function emailResultsPublished(assessmentId: string): Promise<void> {
  try {
    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      select: {
        title: true,
        assignment: {
          select: {
            course: { select: { name: true } },
            class: { select: { name: true } },
            semester: { select: { name: true } },
          },
        },
      },
    });
    if (!assessment) return;

    const results = await prisma.assessmentResult.findMany({
      where: { assessmentId, status: "PUBLISHED" },
      select: {
        enrollment: {
          select: {
            student: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });
    const recipients = results
      .map((r) => r.enrollment.student)
      .filter((s): s is { id: string; fullName: string; email: string } => !!s.email);
    if (recipients.length === 0) return;

    const [{ subject, body }, domainName] = await Promise.all([
      getEffectiveAutomaticEmail("RESULTS_PUBLISHED_EMAIL"),
      resolveDomainName(),
    ]);

    for (const student of recipients) {
      const vars = {
        studentName: student.fullName,
        courseName: assessment.assignment.course.name,
        assessmentTitle: assessment.title,
        className: assessment.assignment.class.name,
        semesterName: assessment.assignment.semester.name,
        domainName,
      };
      await sendEmail({
        to: student.email,
        subject: fillTemplate(subject, vars),
        text: fillTemplate(body, vars),
        log: {
          recipientType: "STUDENT",
          recipientId: student.id,
          eventKey: "RESULTS_PUBLISHED_EMAIL",
          entity: "Assessment",
          entityId: assessmentId,
        },
      });
    }
  } catch (error) {
    console.error("[email-notify] emailResultsPublished failed", error);
  }
}
