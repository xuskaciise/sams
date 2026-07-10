"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/(app)/actions";

// Full document navigation after logout, not router.push/refresh — those
// only invalidate the current route's client Router Cache entry, leaving
// other previously-visited pages cached under the old session and
// servable (stale) once a different user logs in in the same tab.
export function LogoutButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title="Log out"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await logout();
          window.location.href = "/login";
        });
      }}
    >
      <LogOut className="size-4" />
      <span className="sr-only">Log out</span>
    </Button>
  );
}
