import type { Metadata } from "next";
import Link from "next/link";

// Public, static page — exempted from auth in proxy.ts (ALWAYS_PUBLIC_PATHS).
// Required for Google OAuth branding verification; keep it reachable
// without a login.

export const metadata: Metadata = {
  title: "Privacy Policy — SAMS",
  description: "How SAMS collects, uses, and protects your data.",
};

const CONTACT_EMAIL = "fect_fa@siu.edu.so";
const LAST_UPDATED = "28 September 2026";

export default function PrivacyPage() {
  return (
    <main className="flex-1 bg-gray-50 px-4 py-10 sm:py-16">
      <article className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6 text-sm leading-relaxed text-foreground sm:p-10">
        <header className="mb-6 space-y-1">
          <h1 className="text-2xl font-semibold">Privacy Policy</h1>
          <p className="text-muted-foreground">
            SAMS — Student Assessment Management System · Last updated{" "}
            {LAST_UPDATED}
          </p>
        </header>

        <div className="space-y-5">
          <section className="space-y-2">
            <h2 className="text-base font-semibold">What we collect</h2>
            <p>
              SAMS is the university&apos;s continuous-assessment management
              system. It stores the information needed to run academic
              administration: names, student and staff ID numbers, contact
              details (such as phone numbers and email addresses), class and
              course enrollments, timetables, and academic records including
              assessment marks and results.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Why we use it</h2>
            <p>
              This data is used only for academic administration — recording
              and publishing assessment results, managing classes, courses and
              timetables, and sending notices related to those activities.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Who can see it</h2>
            <p>
              Access is role-based. Administrators, deans, lecturers, and
              students each see only what their role requires: deans see
              their own faculties, lecturers see the courses they teach, and
              students see only their own published results. Every sensitive
              action is recorded in an audit log.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Sharing</h2>
            <p>
              We do not sell your data, and we do not share it with third
              parties for marketing or any purpose unrelated to academic
              administration.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Integrations</h2>
            <p>
              Optional integrations — WhatsApp and email notifications, and
              Google Drive for lecturers who choose to connect it — only ever
              handle the data a user explicitly authorizes for that purpose.
              A Google account connection can be revoked at any time from your
              Google account settings.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Contact</h2>
            <p>
              Questions about this policy or your data? Email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-indigo-600 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>

        <footer className="mt-8 border-t border-border pt-4 text-muted-foreground">
          <Link href="/login" className="hover:underline">
            ← Back to SAMS
          </Link>
        </footer>
      </article>
    </main>
  );
}
