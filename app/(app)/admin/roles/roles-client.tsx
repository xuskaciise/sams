"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus, ShieldCheck } from "lucide-react";
import type { Permission, Role, RolePermission } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { getActionErrorMessage } from "@/lib/action-error";
import { createRole, updateRole, deleteRole } from "./actions";

type RoleRow = Role & {
  rolePermissions: (RolePermission & { permission: Permission })[];
  _count: { userRoles: number };
};

const ERROR_MESSAGES: Record<string, string> = {
  SYSTEM_ROLE_NOT_DELETABLE: "System roles cannot be deleted.",
  SYSTEM_ROLE_NAME_IMMUTABLE: "System roles cannot be renamed.",
  SELF_LOCKOUT:
    "Blocked: this change would remove your own ability to manage users.",
  LAST_USER_MANAGER:
    "Blocked: this change would leave no active user able to manage users.",
};

export function groupByCategory(
  permissions: Permission[]
): { category: string; permissions: Permission[] }[] {
  const groups = new Map<string, Permission[]>();
  for (const p of permissions) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }
  return Array.from(groups.entries()).map(([category, list]) => ({
    category,
    permissions: list,
  }));
}

// Checkbox matrix of every permission, grouped by category — shared by
// the role dialog and the per-user overrides dialog on the Users tab.
export function PermissionMatrix({
  permissions,
  isChecked,
  onToggle,
  renderExtra,
}: {
  permissions: Permission[];
  isChecked: (p: Permission) => boolean;
  onToggle: (p: Permission, checked: boolean) => void;
  renderExtra?: (p: Permission) => React.ReactNode;
}) {
  const groups = useMemo(() => groupByCategory(permissions), [permissions]);
  return (
    <div className="flex max-h-96 flex-col gap-4 overflow-y-auto rounded-lg border border-border p-3">
      {groups.map((group) => (
        <div key={group.category} className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase">
            {group.category}
          </p>
          {group.permissions.map((p) => (
            <div key={p.id} className="flex items-start gap-2">
              <Checkbox
                id={`perm-${p.id}`}
                checked={isChecked(p)}
                onCheckedChange={(value) => onToggle(p, value === true)}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <Label htmlFor={`perm-${p.id}`} className="font-mono text-xs">
                  {p.key}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {p.description}
                </span>
              </div>
              {renderExtra?.(p)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function RolesClient({
  roles,
  permissions,
}: {
  roles: RoleRow[];
  permissions: Permission[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [nameError, setNameError] = useState("");

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setSelectedKeys(new Set());
    setNameError("");
    setDialogOpen(true);
  }

  function openEdit(role: RoleRow) {
    setEditing(role);
    setName(role.name);
    setDescription(role.description ?? "");
    setSelectedKeys(
      new Set(role.rolePermissions.map((rp) => rp.permission.key))
    );
    setNameError("");
    setDialogOpen(true);
  }

  async function onSave() {
    if (!name.trim()) {
      setNameError("Role name is required");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: name.trim(),
        description: description.trim(),
        permissionKeys: Array.from(selectedKeys),
      };
      if (editing) {
        await updateRole(editing.id, input);
        toast.success("Role updated.");
      } else {
        await createRole(input);
        toast.success("Role created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      toast.error(
        ERROR_MESSAGES[code] ??
          getActionErrorMessage(
            error,
            "Something went wrong. That role name may already exist."
          )
      );
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await deleteRole(deleting.id);
      toast.success("Role deleted.");
      setDeleting(null);
      startTransition(() => router.refresh());
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Roles & Permissions"
        description="Roles bundle permissions; users can hold several roles plus per-user overrides."
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add role
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Permissions</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role, i) => (
              <TableRow
                key={role.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-2">
                    {role.name}
                    {role.isSystem && (
                      <Badge variant="outline">
                        <ShieldCheck className="size-3" />
                        System
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {role.description ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  {role.rolePermissions.length}
                </TableCell>
                <TableCell className="text-right">
                  {role._count.userRoles}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(role)}>
                        Edit permissions
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={role.isSystem}
                        onClick={() => setDeleting(role)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit role" : "Add role"}</DialogTitle>
            {editing?.isSystem && (
              <DialogDescription>
                System role — the name is fixed, but its permissions can be
                changed.
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError("");
                }}
                disabled={editing?.isSystem ?? false}
              />
              {nameError && (
                <p className="text-sm text-destructive">{nameError}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-description">Description (optional)</Label>
              <Textarea
                id="role-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Permissions</Label>
              <PermissionMatrix
                permissions={permissions}
                isChecked={(p) => selectedKeys.has(p.key)}
                onToggle={(p, checked) =>
                  setSelectedKeys((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(p.key);
                    else next.delete(p.key);
                    return next;
                  })
                }
              />
            </div>
            <Button onClick={onSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create role"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete role?</DialogTitle>
            <DialogDescription>
              {deleting?._count.userRoles
                ? `${deleting.name} is held by ${deleting._count.userRoles} user(s) — they will lose this role and every permission it grants. `
                : ""}
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDelete} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Delete role
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
