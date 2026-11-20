import type { MiddlewareHandler } from "hono";

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
};
