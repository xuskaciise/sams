export function getActionErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error) {
    if (error.message === "UNAUTHENTICATED") {
      return "Your session has expired. Please log in again.";
    }
    if (error.message === "FORBIDDEN") {
      return "You don't have permission to do this.";
    }
  }
  return fallback;
}
