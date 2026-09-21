import { PrismaClient } from "$lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import ENV from "./env";

const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: ENV.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
