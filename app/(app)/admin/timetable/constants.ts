// Split out from queries.ts so client components can import this runtime
// constant without dragging in queries.ts's server-only imports
// (@/lib/auth uses next/headers, which cannot reach a client bundle).
export const ALL_SEMESTERS_VALUE = "all";
