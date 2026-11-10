import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

// PLANTED: AUTH005 - checks login but not role: any user can list every user
export async function GET() {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  return Response.json(users);
}
