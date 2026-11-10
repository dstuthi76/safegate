import { prisma } from "@/lib/db";

// SAFE: public read of published content only. Expected: no findings.
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const post = await prisma.post.findFirst({ where: { slug: params.slug, published: true } });
  if (!post) return new Response("Not found", { status: 404 });
  return Response.json(post);
}
