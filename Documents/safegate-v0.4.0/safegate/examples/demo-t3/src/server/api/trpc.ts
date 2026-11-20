import { initTRPC, TRPCError } from "@trpc/server";
import { db } from "~/server/db";

type Context = { db: typeof db; session: { user: { id: string; role: string } } | null };

const t = initTRPC.context<Context>().create();

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { session: ctx.session } });
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.session?.user.role !== "ADMIN") throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
