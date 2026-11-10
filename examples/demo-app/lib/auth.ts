// Stand-in for NextAuth / Auth.js. safegate recognises calls to auth(), getServerSession(), etc.
export async function auth(): Promise<{ user: { id: string; role: "USER" | "ADMIN" } } | null> {
  return null;
}
