// Demo schema in the create-t3-app style. Planted bugs live in src/server/api, src/server/edge.ts and drizzle/.
import { pgTableCreator } from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `demo_${name}`);

export const users = createTable("user", (d) => ({
  id: d.varchar({ length: 255 }).primaryKey(),
  name: d.varchar({ length: 255 }),
  role: d.varchar({ length: 20 }).default("USER").notNull(),
}));

export const notes = createTable("note", (d) => ({
  id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
  title: d.varchar({ length: 256 }).notNull(),
  body: d.text(),
  isPublic: d.boolean().default(false).notNull(),
  createdById: d.varchar({ length: 255 }).notNull(),
}));

export const tags = createTable("tag", (d) => ({
  id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
  label: d.varchar({ length: 64 }).notNull(),
}));
