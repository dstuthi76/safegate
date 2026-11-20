"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";

// PLANTED: AUTH001 - server actions are public HTTP endpoints; this one never checks the caller
export async function deletePost(postId: string) {
  await prisma.post.delete({ where: { id: postId } });
  revalidatePath("/posts");
}

// PLANTED: AUTH004 (high) - the caller can send { role: "ADMIN" } and promote themselves
export async function updateProfile(data: { name?: string; about?: string }) {
  const session = await auth();
  if (!session) throw new Error("Unauthorized");
  await prisma.user.update({ where: { id: session.user.id }, data });
}

// SAFE: authenticated and scoped to the owner. Expected: no findings.
export async function publishPost(postId: string) {
  const session = await auth();
  if (!session) throw new Error("Unauthorized");
  await prisma.post.update({
    where: { id: postId, authorId: session.user.id },
    data: { published: true },
  });
}
