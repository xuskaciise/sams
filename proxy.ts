import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  hashSessionToken,
  isSessionIdleExpired,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";

const PUBLIC_PATHS = new Set(["/login"]);

// Redirect to /login, clearing whatever session cookie the browser sent —
// used both for "never had a valid session" and "session just expired"
// (idle timeout or otherwise), so a stale cookie never lingers past the
// redirect that invalidated it.
function redirectToLogin(request: NextRequest, reason?: string) {
  const url = new URL("/login", request.url);
  if (reason) url.searchParams.set("reason", reason);
  const response = NextResponse.redirect(url);
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  let hasValidSession = false;
  let mustChangePw = false;
  let idleTimedOut = false;

  if (token) {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });

    if (
      session &&
      session.expiresAt > new Date() &&
      session.user.isActive &&
      !session.user.deletedAt
    ) {
      if (isSessionIdleExpired(session.lastActivityAt)) {
        // Applies uniformly to every role — admin/dean/lecturer/student
        // all pass through this same gate. Deliberately does not delete
        // the session row (same "just treat it as invalid" convention
        // the pre-existing absolute-expiresAt check already followed) —
        // it will keep evaluating as idle-expired on any future request
        // regardless, since lastActivityAt is never bumped for a session
        // no request is authenticating with anymore.
        idleTimedOut = true;
      } else {
        hasValidSession = true;
        mustChangePw = session.user.mustChangePw;
        // Sliding idle window: bump on every authenticated request. This
        // proxy is the one gate every request passes through — including
        // Server Actions, which POST to the same route — so this single
        // update covers page navigations and actions alike.
        await prisma.session.update({
          where: { id: session.id },
          data: { lastActivityAt: new Date() },
        });
      }
    }
  }

  if (!hasValidSession) {
    if (PUBLIC_PATHS.has(pathname)) {
      if (idleTimedOut) {
        const response = NextResponse.next();
        response.cookies.delete(SESSION_COOKIE_NAME);
        return response;
      }
      return NextResponse.next();
    }
    return redirectToLogin(request, idleTimedOut ? "idle_timeout" : undefined);
  }

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (mustChangePw && pathname !== "/change-password") {
    return NextResponse.redirect(new URL("/change-password", request.url));
  }

  if (!mustChangePw && pathname === "/change-password") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
