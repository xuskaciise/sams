import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

console.log("--- Departments/Programs/Classes ---");
console.log(await prisma.department.findMany());
console.log(await prisma.program.findMany());
console.log(await prisma.class.findMany());

console.log("--- Courses ---");
console.log(await prisma.course.findMany());

console.log("--- AcademicYears/Semesters ---");
console.log(await prisma.academicYear.findMany());
console.log(await prisma.semester.findMany());

console.log("--- Users/Lecturers/Students ---");
console.log(await prisma.user.findMany({ select: { id: true, email: true, fullName: true, role: true } }));
console.log(await prisma.lecturer.findMany());
console.log(await prisma.student.findMany());

console.log("--- Assignments/Enrollments ---");
console.log(await prisma.lecturerCourseAssignment.findMany());
console.log(await prisma.studentCourseEnrollment.findMany());

console.log("--- AssessmentTypes ---");
console.log(await prisma.assessmentType.findMany());

await prisma.$disconnect();
