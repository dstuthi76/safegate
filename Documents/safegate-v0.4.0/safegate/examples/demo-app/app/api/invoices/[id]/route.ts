import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

// SAFE: loads by id, then checks ownership before returning. Expected: no findings.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const invoice = await prisma.invoice.findUnique({ where: { id: params.id } });
  if (!invoice || invoice.userId !== session.user.id) {
    return new Response("Not found", { status: 404 });
  }
  return Response.json(invoice);
}

// SAFE: ownership lookup first, then delete by id. Expected: no findings.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const owned = await prisma.invoice.findFirst({ where: { id: params.id, userId: session.user.id } });
  if (!owned) return new Response("Not found", { status: 404 });
  await prisma.invoice.delete({ where: { id: owned.id } });
  return new Response(null, { status: 204 });
}
