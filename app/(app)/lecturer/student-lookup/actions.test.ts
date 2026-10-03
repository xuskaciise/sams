import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn() }));
vi.mock("./queries", () => ({ getStudentResultsForLecturer: vi.fn() }));

import { requirePermission } from "@/lib/auth";
import { getStudentResultsForLecturer } from "./queries";
import { lookupStudentResults } from "./actions";

describe("lookupStudentResults", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires results.enter and scopes the lookup to the caller", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(getStudentResultsForLecturer).mockResolvedValue(null);
    await lookupStudentResults("S1");
    expect(requirePermission).toHaveBeenCalledWith("results.enter");
    expect(getStudentResultsForLecturer).toHaveBeenCalledWith("user-1", "S1");
  });

  it("rejects a caller without results.enter", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(lookupStudentResults("S1")).rejects.toThrow("FORBIDDEN");
    expect(getStudentResultsForLecturer).not.toHaveBeenCalled();
  });
});
