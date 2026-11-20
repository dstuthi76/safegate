import { prisma } from "./db";

// PLANTED: XCHK001 - still reads Invoice.legacyCode, which migration 20240501000000_drop_legacy removes
export async function findByLegacyCode(code: string) {
  return prisma.$queryRaw`SELECT * FROM "Invoice" WHERE "legacyCode" = ${code}`;
}
