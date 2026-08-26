"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { login } from "./actions";

const IDLE_TIMEOUT_MESSAGE =
  "Your session expired due to inactivity — please log in again.";

const loginSchema = z.object({
  identifier: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

// Full document navigation, not router.push/refresh — this browser tab may
// have a stale client Router Cache entry from a previous user's session
// (see logout-button.tsx for the same reasoning). Kept as a module-level
// function, not inlined in the handler, since window.location.href is a
// side effect the React Compiler's lint rule otherwise flags as mutating
// a component-external value.
function hardNavigate(url: string) {
  window.location.href = url;
}

// Reads the ?reason=idle_timeout param proxy.ts's redirect attaches when it
// bounces an idle-timed-out session here. A separate component (rather than
// calling useSearchParams directly in LoginPage) so only this small piece
// needs the Suspense boundary useSearchParams requires in an otherwise fully
// client-rendered page.
function SessionExpiryNotice() {
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");

  useEffect(() => {
    if (reason === "idle_timeout") {
      toast.error(IDLE_TIMEOUT_MESSAGE);
    }
  }, [reason]);

  if (reason !== "idle_timeout") return null;

  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      {IDLE_TIMEOUT_MESSAGE}
    </p>
  );
}

export default function LoginPage() {
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    const formData = new FormData();
    formData.set("identifier", values.identifier);
    formData.set("password", values.password);

    const result = await login(undefined, formData);

    if (result.success) {
      toast.success("Signed in successfully.");
      hardNavigate(result.mustChangePassword ? "/change-password" : "/");
    } else {
      toast.error(result.error);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Enter your SAMS credentials to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Suspense fallback={null}>
            <SessionExpiryNotice />
          </Suspense>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="identifier"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username or email</FormLabel>
                    <FormControl>
                      <Input autoComplete="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete="current-password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
