import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const l = await prisma.lecturer.findFirst({ where: { availability: { some: {} } } });
console.log(l);
await prisma.$disconnect();
