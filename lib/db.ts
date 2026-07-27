import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Explicit safety margin for interactive transactions that loop over a
// variable-sized batch (bulk imports, auto-enroll fan-out from Open
// Semester / Bulk Assign). Prisma's defaults (5s timeout, 2s maxWait) are
// sized for a single request, not a loop over dozens of rows — several
// bulk flows hit "Transaction already closed" / timeout errors on
// larger batches before this was added. Pass as the second argument:
// prisma.$transaction(fn, BULK_TRANSACTION_OPTIONS). Any slow, non-DB
// work (password hashing, etc.) must still happen BEFORE the
// transaction opens regardless of this margin — see CLAUDE.md.
export const BULK_TRANSACTION_OPTIONS = { timeout: 30000, maxWait: 10000 };
