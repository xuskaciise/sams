"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import type {
  OverrideEffect,
  Permission,
  Role,
  RolePermission,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
import { updateUserAccess } from "../roles/actions";

export type RoleWithPermissions = Role & {
  rolePermissions: (RolePermission & { permission: Permission })[];
};

interface OverrideDraft {
  permissionId: string;
  effect: OverrideEffect;
}

const ERROR_MESSAGES: Record<string, string> = {
  SELF_LOCKOUT:
    "Blocked: this change would remove your own ability to manage users.",
  LAST_USER_MANAGER:
    "Blocked: this change would leave no active user able to manage users.",
  INVALID_ROLE: "The STUDENT role cannot be assigned here.",
};

const EFFECT_ITEMS = [
  { value: "GRANT", label: "Grant" },
  { value: "DENY", label: "Deny" },
];

export function UserAccessDialog({
  open,
  onOpenChange,
  userId,
  userName,
  initialRoleIds,
  initialOverrides,
  roles,
  permissions,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  initialRoleIds: string[];
  initialOverrides: OverrideDraft[];
  // Assignable roles only (STUDENT excluded by the panel).
  roles: RoleWithPermissions[];
  permissions: Permission[];
  onSaved: () => void;
}) {
  const [roleIds, setRoleIds] = useState<Set<string>>(
    new Set(initialRoleIds)
  );
  const [overrides, setOverrides] = useState<OverrideDraft[]>(initialOverrides);
  const [addPermissionId, setAddPermissionId] = useState("");
  const [addEffect, setAddEffect] = useState<OverrideEffect>("GRANT");
  const [saving, setSaving] = useState(false);

  const permissionById = useMemo(
    () => new Map(permissions.map((p) => [p.id, p])),
    [permissions]
  );

  // Same math as the server: union of role grants, minus DENYs, plus
  // GRANTs — so the preview always matches what will actually apply.
  const effectiveKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const role of roles) {
      if (!roleIds.has(role.id)) continue;
      for (const rp of role.rolePermissions) keys.add(rp.permission.key);
    }
    for (const o of overrides) {
      const p = permissionById.get(o.permissionId);
      if (!p) continue;
      if (o.effect === "GRANT") keys.add(p.key);
    }
    for (const o of overrides) {
      const p = permissionById.get(o.permissionId);
      if (!p) continue;
      if (o.effect === "DENY") keys.delete(p.key);
    }
    return Array.from(keys).sort();
  }, [roles, roleIds, overrides, permissionById]);

  const availableForOverride = permissions.filter(
    (p) => !overrides.some((o) => o.permissionId === p.id)
  );

  function addOverride() {
    if (!addPermissionId) return;
    setOverrides((prev) => [
      ...prev,
      { permissionId: addPermissionId, effect: addEffect },
    ]);
    setAddPermissionId("");
    setAddEffect("GRANT");
  }

  async function onSave() {
    setSaving(true);
    try {
      await updateUserAccess(userId, {
        roleIds: Array.from(roleIds),
        overrides,
      });
      toast.success("Access updated.");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      toast.error(
        ERROR_MESSAGES[code] ??
          getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Roles &amp; permissions — {userName}</DialogTitle>
          <DialogDescription>
            Effective access = union of role grants, minus Deny overrides,
            plus Grant overrides. Deny always wins.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
            <Label>Roles</Label>
            {roles.map((role) => (
              <div key={role.id} className="flex items-start gap-2">
                <Checkbox
                  id={`user-role-${role.id}`}
                  checked={roleIds.has(role.id)}
                  onCheckedChange={(value) =>
                    setRoleIds((prev) => {
                      const next = new Set(prev);
                      if (value === true) next.add(role.id);
                      else next.delete(role.id);
                      return next;
                    })
                  }
                />
                <div className="flex flex-col">
                  <Label htmlFor={`user-role-${role.id}`}>{role.name}</Label>
                  {role.description && (
                    <span className="text-xs text-muted-foreground">
                      {role.description}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Per-permission overrides</Label>
            {overrides.length === 0 && (
              <p className="text-sm text-muted-foreground">No overrides.</p>
            )}
            {overrides.map((o) => {
              const p = permissionById.get(o.permissionId);
              if (!p) return null;
              return (
                <div
                  key={o.permissionId}
                  className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
                >
                  <Badge
                    variant={o.effect === "DENY" ? "destructive" : "published"}
                  >
                    {o.effect === "DENY" ? "Deny" : "Grant"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {p.key}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setOverrides((prev) =>
                        prev.filter((x) => x.permissionId !== o.permissionId)
                      )
                    }
                  >
                    <X className="size-3.5" />
                    <span className="sr-only">Remove override</span>
                  </Button>
                </div>
              );
            })}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  value={addPermissionId}
                  onValueChange={setAddPermissionId}
                  items={availableForOverride.map((p) => ({
                    value: p.id,
                    label: p.key,
                    keywords: [p.description, p.category],
                  }))}
                  placeholder="Add a permission override…"
                  className="w-full"
                />
              </div>
              <div className="w-28">
                <Select
                  value={addEffect}
                  onValueChange={(value) =>
                    setAddEffect((value as OverrideEffect) ?? "GRANT")
                  }
                  items={EFFECT_ITEMS}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFECT_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={addOverride}
                disabled={!addPermissionId}
              >
                Add
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Effective permissions ({effectiveKeys.length})</Label>
            <div className="flex flex-wrap gap-1 rounded-lg border border-border p-2">
              {effectiveKeys.map((key) => (
                <Badge key={key} variant="secondary" className="font-mono">
                  {key}
                </Badge>
              ))}
              {effectiveKeys.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  No permissions — this user will only be able to log in.
                </span>
              )}
            </div>
          </div>
        </div>

        <Button onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save access
        </Button>
      </DialogContent>
    </Dialog>
  );
}
