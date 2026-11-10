import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

// SAFE: admin route with a role check. Expected: no findings.
export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") return new Response("Forbidden", { status: 403 });
  const count = await prisma.user.count();
  return Response.json({ count });
}
