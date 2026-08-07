// Deterministic, consistent COURSE-level color coding for timetable exports
// (the workload-import multi-class preview's PDF/Excel export — see
// CLAUDE.md's "Cross-period override"-adjacent business rules and the
// "Workload Excel import + auto-timetable generation" section for the
// surrounding feature). Every session of a given course, across every class
// it's taught in, gets the SAME color — colors are assigned once per export
// from the full set of course names present in that export, in a stable
// (alphabetical) order, so re-running an export with the same courses always
// reproduces the same colors.
//
// Base 8 hues are the `dataviz` skill's validated reference categorical
// palette (light-surface hex values from references/palette.md) — CVD-safe
// pairwise (adjacent-pair ΔE ≥ 8 OKLab, normal-vision ΔE ≥ 15) in their
// documented fixed order. A typical semester has more than 8 courses,
// though, and unlike a chart legend, a course can't be generically folded
// into "Other" in a real timetable an admin/lecturer/dean has to read — so
// beyond 8 courses this deliberately cycles back through the SAME 8 hue
// families at a lighter and then a darker tint (8 hues x 3 tiers = 24
// distinct colors) rather than inventing new, unvalidated hues. This is a
// disclosed, deliberate exception to the "never cycle past 8" categorical-
// chart rule: every colored cell in this export ALSO carries the course
// name as a visible text label (see the exporter), which is exactly the
// "secondary encoding" the same rule treats as the legal mitigation for
// going beyond the strict color-alone identification floor.

export interface BaseHue {
  name: string;
  hex: string;
}

export const BASE_HUES: readonly BaseHue[] = [
  { name: "Blue", hex: "#2a78d6" },
  { name: "Orange", hex: "#eb6834" },
  { name: "Aqua", hex: "#1baf7a" },
  { name: "Yellow", hex: "#eda100" },
  { name: "Magenta", hex: "#e87ba4" },
  { name: "Green", hex: "#008300" },
  { name: "Violet", hex: "#4a3aa7" },
  { name: "Red", hex: "#e34948" },
];

const TIER_COUNT = 3; // base, lightened, darkened
const LIGHTEN_AMOUNT = 0.4; // mix 40% toward white
const DARKEN_AMOUNT = 0.35; // mix 35% toward black

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Mixes `hex` toward `target` (0 = hex unchanged, 1 = target exactly) —
// used to derive the lightened/darkened tiers from each base hue, keeping
// the same hue family (not a separate, unvalidated color).
function mixHex(hex: string, target: [number, number, number], amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [tr, tg, tb] = target;
  return rgbToHex(r + (tr - r) * amount, g + (tg - g) * amount, b + (tb - b) * amount);
}

function tierHex(base: BaseHue, tier: number): string {
  if (tier === 0) return base.hex;
  if (tier === 1) return mixHex(base.hex, [255, 255, 255], LIGHTEN_AMOUNT);
  return mixHex(base.hex, [0, 0, 0], DARKEN_AMOUNT);
}

function tierLabel(base: BaseHue, tier: number): string {
  if (tier === 0) return base.name;
  if (tier === 1) return `${base.name} (light)`;
  return `${base.name} (dark)`;
}

// Standard WCAG relative luminance / contrast ratio — used to pick
// black-vs-white text on top of a given fill color so every colored cell
// stays readable regardless of how light or dark its assigned color is.
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA) + 0.05;
  const lB = relativeLuminance(hexB) + 0.05;
  return lA > lB ? lA / lB : lB / lA;
}

// Picks whichever of black/white reads better on `fillHex` — always at
// least one of the two clears a reasonable contrast against any of this
// module's generated fills, so this never needs a third option.
export function pickTextColor(fillHex: string): "#000000" | "#ffffff" {
  return contrastRatio(fillHex, "#000000") >= contrastRatio(fillHex, "#ffffff") ? "#000000" : "#ffffff";
}

export interface CourseColorEntry {
  key: string;
  label: string;
  hex: string;
  colorName: string;
  textColor: "#000000" | "#ffffff";
}

// Colors are keyed by course NAME (not courseId) — every caller in this
// client-side preview pipeline (PreviewSession, ScheduleGridSession,
// CreatedAssignmentSummary, PreviewAssignmentMeta) already only ever
// carries the course's name end-to-end, never its id, so name is the only
// identity available here without a much larger pipeline change to thread
// courseId through the whole preview-state/ScheduleGrid stack for a purely
// cosmetic export feature. The one known edge case (this app's pre-existing
// genuine duplicate `Course` rows with the same name but different ids —
// see CLAUDE.md's "Course pickers" bullet) would just mean two distinct
// courses that happen to share a name also share a color here — a cosmetic
// coincidence, not a correctness issue, since nothing here writes data.
export function assignCourseColors(courseNames: Iterable<string>): Map<string, CourseColorEntry> {
  const unique = [...new Set(courseNames)].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, CourseColorEntry>();
  unique.forEach((name, i) => {
    const hueIndex = i % BASE_HUES.length;
    const tier = Math.floor(i / BASE_HUES.length) % TIER_COUNT;
    const base = BASE_HUES[hueIndex];
    const hex = tierHex(base, tier);
    map.set(name, {
      key: name,
      label: name,
      hex,
      colorName: tierLabel(base, tier),
      textColor: pickTextColor(hex),
    });
  });
  return map;
}
