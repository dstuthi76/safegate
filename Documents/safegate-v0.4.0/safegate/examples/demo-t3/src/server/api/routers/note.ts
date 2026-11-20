import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import { notes } from "~/server/db/schema";

export const noteRouter = createTRPCRouter({
  // SAFE: lists only the caller's notes
  mine: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(notes).where(eq(notes.createdById, ctx.session.user.id)),
  ),

  // PLANTED: AUTH002 - any signed-in user can read any note by changing the id
  byId: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(({ ctx, input }) => ctx.db.query.notes.findFirst({ where: eq(notes.id, input.id) })),

  // SAFE: anyone may read notes marked public
  publicById: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(({ ctx, input }) =>
      ctx.db.query.notes.findFirst({ where: and(eq(notes.id, input.id), eq(notes.isPublic, true)) }),
    ),

  // PLANTED: AUTH001 - a public procedure that deletes data
  purge: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(({ ctx, input }) => ctx.db.delete(notes).where(eq(notes.id, input.id))),

  // PLANTED: AUTH003 - deletes another user's note by id
  remove: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(({ ctx, input }) => ctx.db.delete(notes).where(eq(notes.id, input.id))),

  // SAFE: validated input, explicit fields, scoped to the owner
  rename: protectedProcedure
    .input(z.object({ id: z.number(), title: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.db
        .update(notes)
        .set({ title: input.title })
        .where(and(eq(notes.id, input.id), eq(notes.createdById, ctx.session.user.id))),
    ),
});
