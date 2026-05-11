import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "file:./local.db";
const isNeon = url.startsWith("postgres");

export default {
  schema: isNeon ? "./db/schema.pg.ts" : "./db/schema.ts",
  out: "./drizzle",
  dialect: isNeon ? "postgresql" : "sqlite",
  dbCredentials: { url },
} satisfies Config;
