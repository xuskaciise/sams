import { RoomReassignmentPanel } from "../../admin/room-reassignment/panel";

// Same panel as /admin/room-reassignment — the panel and every action
// re-derive the real faculty scope from the caller's role, so a Dean only
// ever sees/reassigns classes in their own department(s). Same "one
// implementation, two routes" pattern as Timetable / Workload Import.
export default async function DeanRoomReassignmentPage() {
  return <RoomReassignmentPanel />;
}
