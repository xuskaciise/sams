"use server";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { hashSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

// Deliberately does NOT call redirect() — the client does a full document
// navigation instead (see LogoutButton) so the browser's Router Cache is
// dropped entirely. A soft/client-side redirect here would leave pages
// rendered under the old session cached and servable to whoever logs in
// next in the same tab.
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await prisma.session.deleteMany({
      where: { tokenHash: hashSessionToken(token) },
    });
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
}
