import './config';
import { PrismaClient, Prisma } from '@prisma/client';
const globalDb = globalThis as unknown as { orbitdeskDb?: PrismaClient };
export const db = globalDb.orbitdeskDb || new PrismaClient({ log: ['error'] });
if (process.env.NODE_ENV !== 'production') globalDb.orbitdeskDb = db;
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

