import { PrismaClient } from '@prisma/client';

// Ensure a single PrismaClient instance in dev (especially with nodemon reloads)
let globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma || new PrismaClient({
  log: ['error', 'warn'] // add 'query' for debugging if needed
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export { prisma };
