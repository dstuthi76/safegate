import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { notes, users } from "./db/schema";
import { requireAuth } from "./auth";

export const app = new Hono<{ Variables: { userId: string } }>();

app.use("/api/*", requireAuth);

// PLANTED: AUTH004 (high) - the body goes straight into the update, so a caller can set role: "ADMIN"
app.patch("/api/me", async (c) => {
  const body = await c.req.json();
  await db.update(users).set(body).where(eq(users.id, c.get("userId")));
  return c.json({ ok: true });
});

// SAFE: covered by app.use("/api/*", requireAuth) and scoped to the caller
app.get("/api/notes", async (c) => {
  const rows = await db.select().from(notes).where(eq(notes.createdById, c.get("userId")));
  return c.json(rows);
});

// PLANTED: AUTH001 - outside /api, so requireAuth never runs
app.post("/import", async (c) => {
  const { title } = await c.req.json();
  await db.insert(notes).values({ title, createdById: "import" });
  return c.json({ ok: true });
});
