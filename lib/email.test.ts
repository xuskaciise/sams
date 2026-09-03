import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const emailLogCreate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { emailLog: { create: emailLogCreate } },
}));

async function importFresh() {
  vi.resetModules();
  return import("./email");
}

const LOG = {
  recipientType: "STUDENT" as const,
  recipientId: "s1",
  eventKey: "STUDENT_LOGIN_CREDENTIALS_EMAIL",
  entity: "Student",
  entityId: "s1",
};

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("is a no-op SKIPPED when there is no recipient address", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { sendEmail } = await importFresh();

    const res = await sendEmail({ to: null, subject: "x", text: "y", log: LOG });

    expect(res).toEqual({ sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(emailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED", recipientEmail: null }) })
    );
  });

  it("is a no-op SKIPPED when RESEND_API_KEY is unset — never throws", async () => {
    const { sendEmail } = await importFresh();

    const res = await sendEmail({ to: "a@b.com", subject: "x", text: "y", log: LOG });

    expect(res).toEqual({ sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(emailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED" }) })
    );
  });

  it("sends via Resend and logs SENT on success", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "SAMS <no-reply@sams.test>";
    send.mockResolvedValue({ data: { id: "e1" }, error: null });
    const { sendEmail } = await importFresh();

    const res = await sendEmail({ to: "a@b.com", subject: "Sub", text: "Body", log: LOG });

    expect(res).toEqual({ sent: true });
    expect(send).toHaveBeenCalledWith({
      from: "SAMS <no-reply@sams.test>",
      to: "a@b.com",
      subject: "Sub",
      text: "Body",
    });
    expect(emailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT", recipientEmail: "a@b.com", subject: "Sub" }),
      })
    );
  });

  it("logs FAILED and returns sent:false when Resend reports an error — never throws", async () => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockResolvedValue({ data: null, error: { message: "bad address" } });
    const { sendEmail } = await importFresh();

    const res = await sendEmail({ to: "a@b.com", subject: "x", text: "y", log: LOG });

    expect(res).toEqual({ sent: false });
    expect(emailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: "bad address" }) })
    );
  });

  it("swallows a thrown send error", async () => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockRejectedValue(new Error("network"));
    const { sendEmail } = await importFresh();

    await expect(sendEmail({ to: "a@b.com", subject: "x", text: "y", log: LOG })).resolves.toEqual({
      sent: false,
    });
    expect(emailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: "network" }) })
    );
  });
});
