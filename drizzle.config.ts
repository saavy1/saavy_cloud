// Migrations for the auth tables in D1: generated here (npm run db:generate), applied with cf (npm run db:migrate).
import { defineConfig } from "drizzle-kit";

export default defineConfig({ schema: "./auth/schema.ts", out: "./migrations", dialect: "sqlite" });
