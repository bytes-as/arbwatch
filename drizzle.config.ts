import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "file:./local.db";

export default {
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url,
  },
} satisfies Config;
