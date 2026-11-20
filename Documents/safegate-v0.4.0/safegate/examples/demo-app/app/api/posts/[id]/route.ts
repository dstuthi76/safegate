import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

// PLANTED: AUTH002 - logged-in users can read anyone's (including unpublished) post by id
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const post = await prisma.post.findUnique({ where: { id: params.id } });
  return Response.json(post);
}

// PLANTED: AUTH004 - request body goes straight into the update (caller can set authorId, published, ...)
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await req.json();
  const post = await prisma.post.update({
    where: { id: params.id, authorId: session.user.id },
    data: body,
  });
  return Response.json(post);
}

// PLANTED: AUTH003 - any logged-in user can delete any post
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  await prisma.post.delete({ where: { id: params.id } });
  return new Response(null, { status: 204 });
}
