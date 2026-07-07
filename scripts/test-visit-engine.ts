// Plain-assertion tests for the smart-interval engine & scheduler.
// Run: npx tsx scripts/test-visit-engine.ts   (exits non-zero on failure)

import { estimateInterval, humanIntervalLabel, detectIntervalShift, type IntervalEstimate } from "../src/lib/visits/interval";
import { computeSchedule } from "../src/lib/visits/reminders";
import { buildSuggestions, suggestionReasons, type Suggestion } from "../src/lib/visits/suggestions";
import type { Meeting, Rep, Restaurant, SalesHistory } from "../src/lib/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const DAY = 86400000;
const EPOCH = new Date(2024, 0, 1).getTime();
// Build meeting dates from a list of gaps (days between consecutive meetings).
function datesFromGaps(gaps: number[]): Date[] {
  let t = EPOCH;
  const dates = [new Date(t)];
  for (const g of gaps) {
    t += g * DAY;
    dates.push(new Date(t));
  }
  return dates;
}

console.log("Interval estimation");
{
  const e = estimateInterval(datesFromGaps([30, 30]));
  check("3 monthly meetings -> 30d", e.estimatedDays === 30, `got ${e.estimatedDays}`);
  check("3 monthly meetings -> 'Monthly'", e.label === "Monthly", e.label);

  const two = estimateInterval(datesFromGaps([31]));
  check("2 meetings -> ~31d", two.estimatedDays === 31, `got ${two.estimatedDays}`);
  check("2 meetings -> low confidence", two.confidence === "low", two.confidence);

  const one = estimateInterval(datesFromGaps([]));
  check("1 meeting -> null estimate", one.estimatedDays === null);
  check("1 meeting -> low confidence", one.confidence === "low");

  const none = estimateInterval([]);
  check("0 meetings -> null estimate", none.estimatedDays === null);

  const weekly = estimateInterval(datesFromGaps([7, 7, 7]));
  check("weekly -> 'Weekly'", weekly.label === "Weekly", weekly.label);
  const bimonthly = estimateInterval(datesFromGaps([60, 60, 61]));
  check("60d -> 'Every 2 months'", bimonthly.label === "Every 2 months", bimonthly.label);
}

console.log("Gradual adjustment (headline feature)");
{
  // Monthly history, then the rhythm slows to ~60d. Should drift, not jump.
  const step1 = estimateInterval(datesFromGaps([30, 30, 30, 60]));
  check("after first long gap: between 30 and 60 (gradual)",
    step1.estimatedDays! > 30 && step1.estimatedDays! < 60, `got ${step1.estimatedDays}`);

  const step2 = estimateInterval(datesFromGaps([30, 30, 30, 60, 60]));
  check("after second long gap: moves further toward 60",
    step2.estimatedDays! > step1.estimatedDays!, `${step1.estimatedDays} -> ${step2.estimatedDays}`);

  const step4 = estimateInterval(datesFromGaps([30, 60, 60, 60, 60]));
  const step5 = estimateInterval(datesFromGaps([60, 60, 60, 60, 60]));
  check("converges to 60 once the pattern is consistent",
    step5.estimatedDays === 60, `got ${step5.estimatedDays}`);
  check("monotonic-ish drift toward new pace", step4.estimatedDays! >= step2.estimatedDays!);

  // Newest gap carries more weight than older ones.
  const recentHeavier = estimateInterval(datesFromGaps([30, 30, 60]));
  const recentLighter = estimateInterval(datesFromGaps([60, 30, 30]));
  check("recent gaps weigh more than old ones",
    recentHeavier.estimatedDays! > recentLighter.estimatedDays!,
    `${recentLighter.estimatedDays} vs ${recentHeavier.estimatedDays}`);
}

console.log("Outlier robustness");
{
  // A single freak gap among a steady run should be ignored (needs >=4 gaps).
  const withOutlier = estimateInterval(datesFromGaps([30, 30, 30, 120, 30]));
  check("single freak gap ignored -> stays ~30",
    withOutlier.estimatedDays === 30, `got ${withOutlier.estimatedDays}`);
  check("outlier recorded", withOutlier.outliersRemoved.includes(120));
}

console.log("Interval shift detection");
{
  const shift = detectIntervalShift(datesFromGaps([30, 30, 30, 60]));
  check("detects monthly -> slower shift", shift.changed === true, JSON.stringify(shift));
  const steady = detectIntervalShift(datesFromGaps([30, 30, 30, 30]));
  check("no false positive on steady rhythm", steady.changed === false);
}

console.log("Human labels");
{
  check("7 -> Weekly", humanIntervalLabel(7) === "Weekly");
  check("30 -> Monthly", humanIntervalLabel(30) === "Monthly");
  check("60 -> Every 2 months", humanIntervalLabel(60) === "Every 2 months");
  check("182 -> 'Twice a year'", humanIntervalLabel(182) === "Twice a year", humanIntervalLabel(182));
  check("250 -> 'Every 250 days'", humanIntervalLabel(250) === "Every 250 days", humanIntervalLabel(250));
  check("null -> not enough data", humanIntervalLabel(null) === "Not enough data");
}

console.log("Scheduling & reminder states");
{
  const TODAY = new Date(2026, 5, 30); // 30 Jun 2026, local
  const est = (days: number | null): IntervalEstimate => ({
    estimatedDays: days, label: humanIntervalLabel(days), confidence: "high",
    confidenceScore: 0.8, basedOnMeetings: 4, observedIntervals: [], usedIntervals: [], outliersRemoved: [],
  });
  const base = {
    manualIntervalDays: null as number | null,
    customNextDate: null as Date | null,
    clientPaused: false,
    defaultIntervalDays: 30,
    dueSoonLeadDays: 7,
    today: TODAY,
  };
  const at = (daysAgo: number) => new Date(TODAY.getTime() - daysAgo * DAY);

  const overdue = computeSchedule({ ...base, intervalMode: "automatic", estimate: est(30), completedMeetingDates: [at(31)] });
  check("overdue when next date passed", overdue.reminderState === "overdue", overdue.reminderState);
  check("overdue days computed", overdue.daysOverdue === 1, `${overdue.daysOverdue}`);

  const dueToday = computeSchedule({ ...base, intervalMode: "automatic", estimate: est(30), completedMeetingDates: [at(30)] });
  check("due today at exactly the interval", dueToday.reminderState === "due_today", dueToday.reminderState);

  const soon = computeSchedule({ ...base, intervalMode: "automatic", estimate: est(30), completedMeetingDates: [at(25)] });
  check("due soon within lead window", soon.reminderState === "upcoming", soon.reminderState);

  const onTrack = computeSchedule({ ...base, intervalMode: "automatic", estimate: est(30), completedMeetingDates: [at(5)] });
  check("on track when far from due", onTrack.reminderState === "recent", onTrack.reminderState);

  const noHistory = computeSchedule({ ...base, intervalMode: "automatic", estimate: est(null), completedMeetingDates: [] });
  check("no history when no meetings", noHistory.reminderState === "no_history", noHistory.reminderState);
  check("no-history falls back to default interval", noHistory.effectiveIntervalDays === 30 && noHistory.intervalSource === "default");

  const paused = computeSchedule({ ...base, clientPaused: true, intervalMode: "paused", estimate: est(30), completedMeetingDates: [at(100)] });
  check("paused suppresses reminders", paused.reminderState === "paused" && paused.nextSuggestedDate === null);

  const manual = computeSchedule({ ...base, intervalMode: "manual", manualIntervalDays: 14, estimate: est(30), completedMeetingDates: [at(20)] });
  check("manual interval overrides learned", manual.intervalSource === "manual" && manual.effectiveIntervalDays === 14);
  check("manual overdue (20d since, 14d interval)", manual.reminderState === "overdue", manual.reminderState);

  const custom = computeSchedule({ ...base, intervalMode: "custom_date", customNextDate: new Date(TODAY.getTime() + 3 * DAY), estimate: est(30), completedMeetingDates: [at(40)] });
  check("custom date drives schedule", custom.intervalSource === "custom_date" && custom.reminderState === "upcoming", custom.reminderState);
}

console.log("Suggested visits & reason filters");
{
  const TODAY = new Date(2026, 6, 7); // 7 Jul 2026, Tuesday
  const rep: Rep = { id: "rep-a", name: "Rep A" };

  const at = (daysFromToday: number) => {
    const d = new Date(TODAY.getTime() + daysFromToday * DAY);
    d.setHours(12, 0, 0, 0);
    return d;
  };

  const venue = (id: string, name: string, overrides: Partial<Restaurant> = {}): Restaurant => ({
    id,
    name,
    address: "1 Test Street",
    postcode: "W1 1AA",
    borough: "Westminster",
    latitude: 51.515,
    longitude: -0.14,
    cuisineType: "Italian",
    businessType: "Restaurant",
    priceTier: 3,
    openingStatus: "open",
    firstSeenDate: "2026-01-01",
    lastSeenDate: "2026-07-01",
    source: "test",
    existingCustomer: true,
    excluded: false,
    insideDeliveryArea: true,
    leadScore: 50,
    leadCategory: "possible",
    recommended: false,
    scoreBreakdown: { cuisineFit: 25, priceFit: 25 },
    scoreReason: "test",
    outreachStatus: "not_contacted",
    ...overrides,
  });

  const scheduled = (v: Restaurant, dayOffset: number, id = `m-${v.id}`): Meeting => ({
    id,
    repId: rep.id,
    repName: rep.name,
    venueId: v.id,
    venueName: v.name,
    date: at(dayOffset).toISOString(),
    type: "in_person",
    status: "scheduled",
    locked: true,
    source: "rep",
    createdAt: TODAY.toISOString(),
  });

  const volumeDropHistory: SalesHistory = {
    monthly: [
      { month: "2026-01", sales: 100, kg: null },
      { month: "2026-02", sales: 100, kg: null },
      { month: "2026-03", sales: 100, kg: null },
      { month: "2026-04", sales: 50, kg: null },
      { month: "2026-05", sales: 50, kg: null },
      { month: "2026-06", sales: 50, kg: null },
    ],
    priorProducts: [],
    recentProducts: [],
    syncedAt: TODAY.toISOString(),
  };

  const stoppedHistory: SalesHistory = {
    monthly: [
      { month: "2026-01", sales: 100, kg: null },
      { month: "2026-02", sales: 100, kg: null },
      { month: "2026-03", sales: 100, kg: null },
    ],
    priorProducts: [],
    recentProducts: [],
    syncedAt: TODAY.toISOString(),
  };

  const productSwitchHistory: SalesHistory = {
    monthly: [],
    priorProducts: [{ code: "BEEF", description: "beef ravioli", sales: 700 }],
    recentProducts: [{ code: "TRUFFLE", description: "truffle ravioli", sales: 700 }],
    syncedAt: TODAY.toISOString(),
  };

  const dueSetup = venue("due-setup", "Due from setup", {
    visitSettings: { intervalMode: "manual", manualIntervalDays: 30 },
  });
  const dueSetupResult = buildSuggestions({ rep, venues: [dueSetup], meetings: [], today: TODAY }).suggestions[0];
  check("rep-set cadence with no history is suggested as due", suggestionReasons(dueSetupResult).includes("due"));

  const overdue = venue("overdue", "Overdue venue", {
    visitSettings: { intervalMode: "manual", manualIntervalDays: 30 },
    contactLog: [{ id: "n1", author: "Rep A", text: "Visited", outcome: "visited", at: at(-45).toISOString() }],
  });
  const overdueResult = buildSuggestions({ rep, venues: [overdue], meetings: [], today: TODAY }).suggestions[0];
  check("past-due rhythm is an overdue reason", suggestionReasons(overdueResult).includes("overdue"));

  const volumeDrop = venue("volume-drop", "Volume drop", { salesHistory: volumeDropHistory });
  const volumeDropResult = buildSuggestions({ rep, venues: [volumeDrop], meetings: [], today: TODAY }).suggestions[0];
  const volumeReasons = suggestionReasons(volumeDropResult);
  check("sales-only volume drop carries ordering-down reason", volumeReasons.includes("volume_drop"));
  check("sales-only volume drop is not mislabelled due", !volumeReasons.includes("due") && !volumeReasons.includes("overdue"));

  const stopped = venue("stopped", "Stopped ordering", { salesHistory: stoppedHistory });
  const stoppedResult = buildSuggestions({ rep, venues: [stopped], meetings: [], today: TODAY }).suggestions[0];
  check("stopped ordering carries gone-quiet reason", suggestionReasons(stoppedResult).includes("stopped_ordering"));

  const productSwitch = venue("product-switch", "Product switch", { salesHistory: productSwitchHistory });
  const productSwitchResult = buildSuggestions({ rep, venues: [productSwitch], meetings: [], today: TODAY }).suggestions[0];
  check("product switch carries product-change reason", suggestionReasons(productSwitchResult).includes("product_switch"));

  const clusteredA = venue("clustered-a", "Clustered A", {
    latitude: 51.515,
    longitude: -0.14,
    visitSettings: { intervalMode: "manual", manualIntervalDays: 30 },
  });
  const clusteredB = venue("clustered-b", "Clustered B", {
    latitude: 51.516,
    longitude: -0.141,
    visitSettings: { intervalMode: "manual", manualIntervalDays: 30 },
  });
  const clustered = buildSuggestions({ rep, venues: [clusteredA, clusteredB], meetings: [], today: TODAY }).suggestions;
  check("co-placed suggestions do not count as booked visits", clustered.every((s) => s.suggestedBatchCount === 0));
  check("co-placed suggestions alone are not a nearby reason", clustered.every((s) => !suggestionReasons(s).includes("nearby")));

  const booked = venue("booked", "Booked anchor", { latitude: 51.515, longitude: -0.14 });
  const nearbyDue = venue("nearby-due", "Nearby due", {
    latitude: 51.516,
    longitude: -0.141,
    visitSettings: { intervalMode: "manual", manualIntervalDays: 30 },
  });
  const nearbyResult = buildSuggestions({
    rep,
    venues: [booked, nearbyDue],
    meetings: [scheduled(booked, 0)],
    today: TODAY,
  }).suggestions.find((s) => s.venueId === nearbyDue.id);
  check("due visit near a confirmed booking reports the booked batch", nearbyResult?.suggestedBatchCount === 1);
  check("due visit near a confirmed booking carries nearby reason", !!nearbyResult && suggestionReasons(nearbyResult).includes("nearby"));

  const farSameDay: Suggestion = { ...nearbyResult!, nearestBookedMeters: 100_000 };
  check("same-day booking only becomes nearby within the radius", !suggestionReasons(farSameDay).includes("nearby"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
