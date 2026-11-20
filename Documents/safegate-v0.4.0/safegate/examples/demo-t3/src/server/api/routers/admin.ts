import { adminProcedure, createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { tags } from "~/server/db/schema";

export const adminRouter = createTRPCRouter({
  // PLANTED: AUTH005 - checks sign-in but not the role, so any user can wipe every tag
  deleteAllTags: protectedProcedure.mutation(({ ctx }) => ctx.db.delete(tags)),

  // SAFE: adminProcedure checks the role
  tagCount: adminProcedure.query(({ ctx }) => ctx.db.select().from(tags)),
});
