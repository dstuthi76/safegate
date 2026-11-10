import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { z } from "zod";

const CreatePost = z.object({ title: z.string().min(1), content: z.string().optional() });

// SAFE: list is scoped to the current user. Expected: no findings.
export async function GET() {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const posts = await prisma.post.findMany({ where: { authorId: session.user.id } });
  return Response.json(posts);
}

// SAFE: validated input, explicit fields, owner set from the session. Expected: no findings.
export async function POST(req: Request) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const input = CreatePost.parse(await req.json());
  const post = await prisma.post.create({
    data: { title: input.title, content: input.content, slug: crypto.randomUUID(), authorId: session.user.id },
  });
  return Response.json(post, { status: 201 });
}
