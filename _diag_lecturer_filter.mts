import { getTimetablePanelData } from "./app/(app)/admin/timetable/queries";

const ADMIN_USER_ID = "91c747d7-773c-4cc4-b671-1431224bd200";
const lecturerId = "8267acd5-13b9-4a7a-a758-b595c99f946f";

async function main() {
  try {
    const data = await getTimetablePanelData(ADMIN_USER_ID, { lecturerId, quick: "full" } as any);
    console.log("OK. slots:", data.slots.length);
    JSON.stringify(data);
    console.log("serialize OK");
  } catch (e: any) {
    console.log("CRASH:", e?.message);
    console.log(e?.stack);
  }
}
main().finally(() => process.exit(0));
