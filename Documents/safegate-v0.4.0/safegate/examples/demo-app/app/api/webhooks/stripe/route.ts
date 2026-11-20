import { prisma } from "@/lib/db";

// SAFE: webhooks are public by design (matched by the default publicRoutes). Expected: no findings.
export async function POST(req: Request) {
  const event = await req.json();
  await prisma.auditLog.create({ data: { action: `stripe:${event.type}` } });
  return new Response("ok");
}
