"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { WorkloadImportClient } from "./workload-import-client";
import {
  ClassWorkloadImportClient,
  type WorkloadImportClassOption,
} from "./class-workload-import-client";
import {
  SemesterWorkloadImportClient,
  type WorkloadImportSemesterOption,
} from "./semester-workload-import-client";
import type { GeneratorShiftOption, GeneratorRoomOption } from "./generator-data";

interface Props {
  classes: WorkloadImportClassOption[];
  semesterNumberOptions: WorkloadImportSemesterOption[];
  canGenerate: boolean;
  shifts: GeneratorShiftOption[];
  rooms: GeneratorRoomOption[];
  activeAcademicSemesterNumber: number | null;
}

// Split out from panel.tsx (an async Server Component, which can't hold
// state) purely so this Tabs instance can be CONTROLLED — value +
// onValueChange, same pattern as admin/timetable/timetable-client.tsx's
// own internal Tabs. An uncontrolled `defaultValue` here triggered a real
// Base UI dev warning ("changing the default value state of an
// uncontrolled Tabs after being initialized"): panel.tsx re-runs on every
// RSC refresh (e.g. after any mutation inside these tabs calls
// router.refresh()), producing a freshly-described `<Tabs>` element each
// time — controlled mode is what Base UI itself recommends to avoid that.
export function WorkloadImportTabsClient({
  classes,
  semesterNumberOptions,
  canGenerate,
  shifts,
  rooms,
  activeAcademicSemesterNumber,
}: Props) {
  const [activeTab, setActiveTab] = useState("semester");

  return (
    <Tabs value={activeTab} onValueChange={(value) => value && setActiveTab(value)}>
      <TabsList>
        <TabsTrigger value="semester">By Semester (Recommended)</TabsTrigger>
        <TabsTrigger value="class">By Class</TabsTrigger>
        <TabsTrigger value="bulk">Bulk Import (Advanced)</TabsTrigger>
      </TabsList>
      <TabsContent value="semester" className="pt-4">
        <SemesterWorkloadImportClient
          semesterNumberOptions={semesterNumberOptions}
          canGenerate={canGenerate}
          shifts={shifts}
          rooms={rooms}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
        />
      </TabsContent>
      <TabsContent value="class" className="pt-4">
        <ClassWorkloadImportClient
          classes={classes}
          canGenerate={canGenerate}
          shifts={shifts}
          rooms={rooms}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
        />
      </TabsContent>
      <TabsContent value="bulk" className="pt-4">
        <WorkloadImportClient
          canGenerate={canGenerate}
          shifts={shifts}
          rooms={rooms}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
        />
      </TabsContent>
    </Tabs>
  );
}
