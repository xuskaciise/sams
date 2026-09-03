import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail }));

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn() },
    assessment: { findUnique: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
  },
}));

// Real template registry + fill; DB has no override rows, so the coded
// defaults (Somali) are used.
vi.mock("@/lib/whatsapp-notify", async () => {
  const templates = await import("./whatsapp-templates");
  return {
    WHATSAPP_SETTINGS_ID: "singleton",
    getEffectiveAutomaticEmail: async (key: string) => ({
      subject: templates.AUTOMATIC_EVENTS[key].defaultSubject ?? "",
      body: templates.AUTOMATIC_EVENTS[key].defaultTemplateText,
    }),
  };
});

import { prisma } from "@/lib/db";
import { emailStudentCredentials, emailResultsPublished } from "./email-notify";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
    id: "singleton",
    domainName: "sams.example.edu",
  } as never);
  sendEmail.mockResolvedValue({ sent: true });
});

describe("emailStudentCredentials", () => {
  const base = {
    studentId: "s1",
    studentNo: "S1001",
    fullName: "Amina Yusuf",
    username: "S1001",
    tempPassword: "Tmp-9xQ",
  };

  it("does nothing (sent:false) and never calls the mailer when the student has no email", async () => {
    const res = await emailStudentCredentials({ ...base, email: null });
    expect(res).toEqual({ sent: false });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fills the credentials template + subject and sends", async () => {
    const res = await emailStudentCredentials({ ...base, email: "amina@example.com" });

    expect(res).toEqual({ sent: true });
    const call = sendEmail.mock.calls[0][0];
    expect(call.to).toBe("amina@example.com");
    expect(call.subject).toContain("Amina Yusuf");
    expect(call.text).toContain("Username: S1001");
    expect(call.text).toContain("Password: Tmp-9xQ");
    expect(call.text).toContain("sams.example.edu");
    expect(call.text).not.toMatch(/\{[a-zA-Z]+\}/); // no leftover tokens
    expect(call.log).toMatchObject({
      recipientType: "STUDENT",
      recipientId: "s1",
      eventKey: "STUDENT_LOGIN_CREDENTIALS_EMAIL",
    });
  });

  it("never throws when the mailer/DB blows up", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockRejectedValue(new Error("DB down"));
    await expect(
      emailStudentCredentials({ ...base, email: "amina@example.com" })
    ).resolves.toEqual({ sent: false });
  });
});

describe("emailResultsPublished", () => {
  beforeEach(() => {
    vi.mocked(prisma.assessment.findUnique).mockResolvedValue({
      title: "Quiz 1",
      assignment: {
        course: { name: "Databases" },
        class: { name: "CMS26-A-FT" },
        semester: { name: "Semester 1" },
      },
    } as never);
  });

  it("emails only the published-result students who have a real email — NO mark in the message", async () => {
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      { enrollment: { student: { id: "s1", fullName: "Amina", email: "amina@example.com" } } },
      { enrollment: { student: { id: "s2", fullName: "Bashir", email: null } } },
      { enrollment: { student: { id: "s3", fullName: "Cali", email: "cali@example.com" } } },
    ] as never);

    await emailResultsPublished("a1");

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const tos = sendEmail.mock.calls.map((c) => c[0].to);
    expect(tos).toEqual(["amina@example.com", "cali@example.com"]);
    for (const [{ text, subject }] of sendEmail.mock.calls) {
      expect(text).toContain("Quiz 1");
      expect(text).toContain("Databases");
      expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(`${subject} ${text}`).not.toMatch(/\bmark\b|\b18\b/i);
    }
  });

  it("does nothing when no published-result student has an email", async () => {
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      { enrollment: { student: { id: "s2", fullName: "Bashir", email: null } } },
    ] as never);

    await emailResultsPublished("a1");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the DB fails", async () => {
    vi.mocked(prisma.assessment.findUnique).mockRejectedValue(new Error("boom"));
    await expect(emailResultsPublished("a1")).resolves.toBeUndefined();
  });
});
