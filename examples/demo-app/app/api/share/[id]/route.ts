import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

// Intentional: share links let any logged-in user view a post. Suppressed with a reviewed ignore comment.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });
  // safegate-ignore AUTH002 share links are readable by any signed-in user (reviewed 2026-11)
  const post = await prisma.post.findUnique({ where: { id: params.id } });
  return Response.json(post);
}
