-- Student.isActive: overall student status (graduated/withdrawn/
-- suspended, etc.), independent of per-course EnrollmentStatus and of
-- User.isActive. Additive, defaults true, so every existing student
-- stays exactly as-is (visible, unrestricted, still auto-enrollable).
ALTER TABLE "students" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
