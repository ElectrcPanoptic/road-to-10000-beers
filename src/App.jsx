import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
  ComposedChart,
  Area,
  AreaChart,
  ReferenceLine,
} from "recharts";

/* ============================================================================
   THE TAPROOM — a modular beer-count tracker for WhatsApp group exports
   ----------------------------------------------------------------------------
   Sections below are designed to be split into their own files later:
     1. CONFIG         → constants, palette, drink emojis
     2. PARSER         → WhatsApp .txt export → message objects
     3. EXTRACTOR      → message → drink count
     4. TRANSFORMERS   → message list → chart-ready data
     5. CHART COMPONENTS → presentational, each takes clean props
     6. APP            → orchestration + upload UI
   ========================================================================== */

/* ============================================================================
   1. CONFIG
   ========================================================================== */

const DRINK_EMOJIS = ["🍺", "🍻", "🍷", "🥃", "🍸", "🍹", "🥂", "🍶"];

const GROUP_TARGET = 10000;

// Palette assigned per-person, cycled in order.
const PERSON_COLORS = [
  "#f4b942", // amber
  "#e07a5f", // terracotta
  "#81b29a", // sage
  "#c06c84", // rose
  "#6a8caf", // steel
  "#d4a373", // caramel
  "#a07cc5", // plum
  "#e8c468", // honey
];

const CHART_BG = "rgba(255,255,255,0.03)";
const GRID = "rgba(244, 185, 66, 0.12)";
const AXIS = "rgba(245, 230, 200, 0.55)";

/* ============================================================================
   2. PARSER — WhatsApp .txt export → message objects
   ----------------------------------------------------------------------------
   Handles the two main formats:
     iOS:     [DD/MM/YYYY, HH:MM:SS] Name: message
     Android: DD/MM/YY, HH:MM - Name: message
   Multi-line messages are joined onto the previous entry.
   ========================================================================== */

const IOS_LINE = /^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\]\s*([^:]+?):\s*(.*)$/i;
const AND_LINE = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*[-–]\s*([^:]+?):\s*(.*)$/i;
// Fallback: timestamped line with no "Author: body" structure → a WhatsApp
// system event ("X added Y", "X changed the group name", etc). We detect
// these explicitly so they don't get appended to the previous message body.
const TS_ONLY = /^\[?(\d{1,2})[./](\d{1,2})[./](\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:AM|PM)?\]?\s*[-–]?\s*/i;

const EDITED_SUFFIX = /\s*<This message was edited>\s*$/i;
// Unanchored so trailing whitespace / invisible chars don't defeat the match.
const DELETED_RX = /(^|\s)(This message was deleted|You deleted this message)(\s|$)/i;

// Strip whitespace and dashes from an author label so "Luke Matthews" →
// "LukeMatthews" and "+44 7812 395124" → "+447812395124". WhatsApp prefixes
// unsaved contacts with "~ " which is also collapsed away.
function cleanAuthorName(name) {
  return name.replace(/^~\s*/, "").replace(/[\s\-]+/g, "");
}

function parseWhatsAppExport(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\u200e/g, ""); // strip LTR marks iOS adds
    if (!line.trim()) continue;
    const m = IOS_LINE.exec(line) || AND_LINE.exec(line);
    if (m) {
      if (current) messages.push(current);
      const [, d, mo, y, h, mi, s, ampm, author, body] = m;
      const year = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
      let hour = parseInt(h, 10);
      if (ampm) {
        if (/PM/i.test(ampm) && hour < 12) hour += 12;
        if (/AM/i.test(ampm) && hour === 12) hour = 0;
      }
      // Day-first assumption (DD/MM). If you're in the US, swap d and mo.
      const date = new Date(
        year,
        parseInt(mo, 10) - 1,
        parseInt(d, 10),
        hour,
        parseInt(mi, 10),
        s ? parseInt(s, 10) : 0
      );
      current = {
        date,
        author: cleanAuthorName(author.trim()),
        body: body.replace(EDITED_SUFFIX, "").trim(),
      };
    } else if (TS_ONLY.test(line)) {
      // System event with a timestamp but no "Author: body" — skip, and
      // do NOT append to the current message. This is the critical fix
      // for exports containing lines like "- X added Y" or "- X changed
      // the group description" that would otherwise corrupt message bodies.
      continue;
    } else if (current) {
      // Genuine continuation line (user pressed enter mid-message).
      current.body += "\n" + line;
    }
  }
  if (current) messages.push(current);

  return messages.filter(
    (m) => !/^\s*$/.test(m.author) && !isSystemMessage(m) && !DELETED_RX.test(m.body)
  );
}

function isSystemMessage(msg) {
  const sys = [
    /end-to-end encrypted/i,
    /created group/i,
    /added you/i,
    /changed the group/i,
    /changed this group/i,
    /changed the subject/i,
    /left$/i,
    /security code/i,
  ];
  return sys.some((rx) => rx.test(msg.body));
}

/* ============================================================================
   3. EXTRACTOR — message → drink entry kind
   ----------------------------------------------------------------------------
   Each row in the export represents ONE drink, in one of two forms:
     · A photo      → "Name: <Media omitted>"
     · A number     → "Name: 7878" (running group total, for display only)
   The number's value is NOT used for arithmetic — it's just a shared counter
   people update as they log a drink. Drink emojis are also treated as
   entries for robustness but are rare.

   Returns one of:
     { kind: "media" }                       — photo entry
     { kind: "number", number: N }           — numeric entry (N kept for display)
     { kind: "emoji" }                       — emoji entry (fallback)
     null                                    — not a drink row
   ========================================================================== */

const MEDIA_RX = /<Media omitted>|image omitted|sticker omitted|\(file attached\)|IMG-\d+/i;

function extractMessageValue(body, { includePhotos = true } = {}) {
  if (DELETED_RX.test(body)) return null;
  if (MEDIA_RX.test(body)) return includePhotos ? { kind: "media" } : null;

  const num = body.match(/(?<!\d)(\d{1,6})(?!\d)/);
  if (num) {
    return { kind: "number", number: parseInt(num[1], 10) };
  }

  // Fallback: drink emojis (still counted as a single entry per message)
  for (const e of DRINK_EMOJIS) {
    if ([...body].some((ch) => ch === e)) return { kind: "emoji" };
  }
  return null;
}

/* ============================================================================
   4. TRANSFORMERS — message list → chart-ready structures
   ========================================================================== */

/* ----------------------------------------------------------------------------
   Aggressive same-time deduplication.

   Common posting pattern in this group: someone posts a photo, then in the
   next minute types the new counter value as a follow-up message for the
   SAME drink. Treat those two rows as one drink. If the toggle is off,
   every row is kept as a distinct drink.

   Rules:
     · Both rows are from the same author.
     · They're adjacent in time order (nobody else posted between them).
     · Their timestamps are within DEDUPE_WINDOW_MS of each other.
     · One is a media row and the other is a numeric row (either order).

   Heads up: because your chat's running counter increments once per row
   (including double-posts), the dedup'd total will be LOWER than the
   counter's current value. That's the honest count of distinct drinks.
   --------------------------------------------------------------------------- */

const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

function buildDrinkEvents(messages, opts = {}) {
  const { mergePairs = true, includePhotos = true } = opts;

  const sorted = [...messages].sort((a, b) => a.date - b.date);
  const typed = [];
  for (const m of sorted) {
    const parsed = extractMessageValue(m.body, { includePhotos });
    if (!parsed) continue;
    typed.push({ ...m, kind: parsed.kind, number: parsed.number ?? null });
  }

  if (!mergePairs) {
    return typed.map((t) => ({ ...t, count: 1 }));
  }

  const toRemove = new Set();
  for (let i = 0; i < typed.length - 1; i++) {
    if (toRemove.has(i) || toRemove.has(i + 1)) continue;
    const a = typed[i];
    const b = typed[i + 1];
    if (b.date - a.date > DEDUPE_WINDOW_MS) continue;
    if (a.author !== b.author) continue;
    const oneOfEach =
      (a.kind === "media" && b.kind === "number") ||
      (a.kind === "number" && b.kind === "media");
    if (oneOfEach) {
      toRemove.add(i + 1); // drop the later row, keep the earlier timestamp
    }
  }

  const events = [];
  for (let i = 0; i < typed.length; i++) {
    if (toRemove.has(i)) continue;
    events.push({ ...typed[i], count: 1 });
  }
  return events;
}

function totalsByPerson(events) {
  const map = new Map();
  for (const e of events) map.set(e.author, (map.get(e.author) || 0) + e.count);
  return [...map.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // Monday = 0
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return date;
}

function thisWeekTotals(events, now = new Date()) {
  const weekStart = startOfWeek(now);
  const inWeek = events.filter((e) => e.date >= weekStart && e.date <= now);
  return totalsByPerson(inWeek);
}

function cumulativeSeries(events) {
  // One row per day; columns per person with running total.
  if (events.length === 0) return { rows: [], people: [] };
  const sorted = [...events].sort((a, b) => a.date - b.date);
  const people = [...new Set(sorted.map((e) => e.author))];
  const running = Object.fromEntries(people.map((p) => [p, 0]));

  const byDay = new Map();
  for (const e of sorted) {
    const key = e.date.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }

  const rows = [];
  for (const [day, dayEvents] of byDay) {
    for (const e of dayEvents) running[e.author] += e.count;
    rows.push({ day, ...running });
  }
  return { rows, people };
}

function dayOfWeekTotals(events) {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const counts = Array(7).fill(0);
  for (const e of events) {
    const dow = (e.date.getDay() + 6) % 7;
    counts[dow] += e.count;
  }
  return names.map((name, i) => ({ name, count: counts[i] }));
}

function hourOfDayTotals(events) {
  const rows = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  for (const e of events) rows[e.date.getHours()].count += e.count;
  return rows;
}

function biggestSessions(events, topN = 5) {
  // A "session" = one person, one calendar day.
  const key = (e) => `${e.author}__${e.date.toISOString().slice(0, 10)}`;
  const map = new Map();
  for (const e of events) {
    const k = key(e);
    if (!map.has(k)) map.set(k, { author: e.author, day: e.date.toISOString().slice(0, 10), total: 0 });
    map.get(k).total += e.count;
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, topN);
}

function colourFor(person, people) {
  const i = people.indexOf(person);
  return PERSON_COLORS[i % PERSON_COLORS.length];
}

/* --- Forecasting -----------------------------------------------------------
   Trend + weekly-seasonality forecast on DAILY INCREMENTS, then summed to
   project cumulative totals. Model: inc_t = a + b·t + s[dow(t)]
   Fit by one-pass backfitting: trend → residuals → per-dow means → zero-
   centre seasonal → refit trend on deseasoned increments. Variance of the
   cumulative k-day-ahead forecast accumulates as σ·√k. A proper Prophet
   call would also add yearly seasonality and changepoints; for a small
   chat this captures the weekly rhythm (Friday/Saturday spikes) honestly.
   --------------------------------------------------------------------------- */

const DAY_MS = 86400000;

function dailyCumulativeTotal(events) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.date - b.date);
  const byDay = new Map();
  for (const e of sorted) {
    const key = e.date.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + e.count);
  }
  // Fill in missing days so the regression sees a continuous time axis.
  const keys = [...byDay.keys()];
  const first = new Date(keys[0]);
  const last = new Date(keys[keys.length - 1]);
  const rows = [];
  let running = 0;
  for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    running += byDay.get(key) || 0;
    rows.push({ day: key, total: running });
  }
  return rows;
}

function forecastWithSeasonality(series, target) {
  if (series.length < 8) return null; // need >= 1 week for seasonality to mean anything

  const t0 = new Date(series[0].day).getTime();

  // Daily increments (how many drinks were added that day)
  const incs = series.map((r, i) => {
    const prev = i === 0 ? 0 : series[i - 1].total;
    const date = new Date(r.day);
    return {
      x: (date.getTime() - t0) / DAY_MS,
      dow: (date.getDay() + 6) % 7, // Mon = 0
      inc: r.total - prev,
    };
  });
  const n = incs.length;

  // --- Step 1: fit linear trend to raw increments
  const fitTrend = (ys) => {
    const meanX = incs.reduce((s, r) => s + r.x, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (incs[i].x - meanX) * (ys[i] - meanY);
      den += (incs[i].x - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    return { slope, intercept };
  };

  let { slope, intercept } = fitTrend(incs.map((r) => r.inc));

  // --- Step 2: per-dow residual means → seasonal component (zero-centred)
  const dowSums = Array(7).fill(0);
  const dowCounts = Array(7).fill(0);
  for (let i = 0; i < n; i++) {
    const resid = incs[i].inc - (intercept + slope * incs[i].x);
    dowSums[incs[i].dow] += resid;
    dowCounts[incs[i].dow] += 1;
  }
  const seasonalRaw = dowSums.map((s, i) => (dowCounts[i] > 0 ? s / dowCounts[i] : 0));
  const seasonalMean = seasonalRaw.reduce((s, v) => s + v, 0) / 7;
  const seasonal = seasonalRaw.map((s) => s - seasonalMean);

  // --- Step 3: refit trend on deseasoned increments (one backfitting pass)
  const deseasoned = incs.map((r) => r.inc - seasonal[r.dow]);
  ({ slope, intercept } = fitTrend(deseasoned));

  // --- Step 4: residual std (dof = n - trend_params - seasonal_params)
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * incs[i].x + seasonal[incs[i].dow];
    ssr += (incs[i].inc - pred) ** 2;
  }
  const dof = Math.max(1, n - 2 - 6); // -2 trend, -6 free seasonal params
  const sigma = Math.sqrt(ssr / dof);

  // --- Step 5: project forward day-by-day, summing increments
  const rows = series.map((r) => ({
    day: r.day,
    actual: r.total,
    forecast: null,
    upper: null,
    lower: null,
  }));
  // Bridge
  const lastActual = series[series.length - 1].total;
  rows[rows.length - 1].forecast = lastActual;
  rows[rows.length - 1].upper = lastActual;
  rows[rows.length - 1].lower = lastActual;

  const lastX = incs[n - 1].x;
  let runningTotal = lastActual;
  let runningVar = 0;
  let etaDate = null;
  let daysToTarget = null;

  const MAX_HORIZON = 365 * 4; // 4-year ceiling
  for (let k = 1; k <= MAX_HORIZON; k++) {
    const x = lastX + k;
    const date = new Date(t0 + x * DAY_MS);
    const dow = (date.getDay() + 6) % 7;
    const predInc = Math.max(0, intercept + slope * x + seasonal[dow]);
    runningTotal += predInc;
    runningVar += sigma * sigma;
    const ci = 1.96 * Math.sqrt(runningVar);

    rows.push({
      day: date.toISOString().slice(0, 10),
      actual: null,
      forecast: runningTotal,
      upper: runningTotal + ci,
      lower: Math.max(0, runningTotal - ci),
    });

    if (etaDate === null && runningTotal >= target) {
      etaDate = date;
      daysToTarget = k;
    }
    // Stop a bit past the target so the chart shows the crossing
    if (etaDate && k > daysToTarget + 14) break;
    // If trend is flat and target is unreachable, stop after 6 months
    if (!etaDate && slope <= 0 && intercept <= 0 && k > 180) break;
  }

  // Current daily rate (trend + average seasonal ≡ trend alone since seasonal sums to 0)
  const currentDailyRate = intercept + slope * lastX;

  return {
    rows,
    slope,
    intercept,
    sigma,
    seasonal,
    etaDate,
    daysToTarget,
    currentTotal: lastActual,
    target,
    dailyRate: currentDailyRate,
  };
}

/* --- Per-person heatmap ----------------------------------------------------
   7 rows (Mon–Sun) × 8 columns (3-hour buckets starting at 00:00).
   Cell value is the sum of drink counts posted in that bucket.
   --------------------------------------------------------------------------- */

function personHeatmap(events, person) {
  const grid = Array.from({ length: 7 }, () => Array(8).fill(0));
  for (const e of events) {
    if (e.author !== person) continue;
    const dow = (e.date.getDay() + 6) % 7; // Mon = 0
    const bucket = Math.floor(e.date.getHours() / 3); // 0..7
    grid[dow][bucket] += e.count;
  }
  return grid;
}

/* ============================================================================
   5. CHART COMPONENTS — presentational, all take clean props
   ========================================================================== */

const panelStyle = {
  background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))",
  border: "1px solid rgba(244, 185, 66, 0.18)",
  borderRadius: "14px",
  padding: "28px 28px 24px",
  boxShadow: "0 20px 60px -30px rgba(0,0,0,0.6)",
};

const panelTitleStyle = {
  fontFamily: "'Fraunces', serif",
  fontSize: "22px",
  fontWeight: 500,
  letterSpacing: "-0.01em",
  color: "#f5e6c8",
  marginBottom: "4px",
};

const panelSubStyle = {
  fontFamily: "'Instrument Sans', sans-serif",
  fontSize: "12px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "rgba(245, 230, 200, 0.5)",
  marginBottom: "20px",
};

function Panel({ title, subtitle, children, style }) {
  return (
    <div className="panel" style={{ ...panelStyle, ...style }}>
      <div className="panel-title" style={panelTitleStyle}>{title}</div>
      {subtitle && <div style={panelSubStyle}>{subtitle}</div>}
      {children}
    </div>
  );
}

function Leaderboard({ data, title, subtitle, people }) {
  return (
    <Panel title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={Math.max(220, data.length * 44)}>
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 40 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <YAxis
            type="category"
            dataKey="name"
            stroke={AXIS}
            width={100}
            tick={{ fontFamily: "'Fraunces', serif", fontSize: 14, fill: "#f5e6c8" }}
          />
          <Tooltip
            cursor={{ fill: "rgba(244,185,66,0.08)" }}
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
            labelStyle={{ color: "#f5e6c8" }}
          />
          <Bar dataKey="total" radius={[0, 6, 6, 0]}>
            {data.map((d) => (
              <Cell key={d.name} fill={colourFor(d.name, people)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function CumulativeChart({ rows, people, selectedPeople }) {
  // If selectedPeople is a Set, show only those; otherwise show all
  const visible = selectedPeople
    ? people.filter((p) => selectedPeople.has(p))
    : people;
  return (
    <Panel title="The long haul" subtitle="Cumulative drinks over time">
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis
            dataKey="day"
            stroke={AXIS}
            tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 10 }}
          />
          <YAxis stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
            labelStyle={{ color: "#f5e6c8" }}
          />
          <Legend wrapperStyle={{ fontFamily: "'Instrument Sans', sans-serif", fontSize: 12 }} />
          {visible.map((p) => (
            <Line
              key={p}
              type="monotone"
              dataKey={p}
              stroke={colourFor(p, people)}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function DayOfWeekChart({ data }) {
  return (
    <Panel title="When the week breaks" subtitle="Drinks by day of week">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="name" stroke={AXIS} tick={{ fontFamily: "'Fraunces', serif", fontSize: 13, fill: "#f5e6c8" }} />
          <YAxis stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: "rgba(244,185,66,0.08)" }}
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          />
          <Bar dataKey="count" fill="#f4b942" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function HourOfDayChart({ data }) {
  return (
    <Panel title="The witching hours" subtitle="Drinks by hour of day">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="hour" stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <YAxis stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: "rgba(224,122,95,0.1)" }}
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          />
          <Bar dataKey="count" fill="#e07a5f" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function SeasonalitySparkline({ seasonal }) {
  if (!seasonal) return null;
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  const maxAbs = Math.max(0.01, ...seasonal.map((v) => Math.abs(v)));

  return (
    <div>
      <div
        style={{
          fontFamily: "'Geist Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(245,230,200,0.5)",
          marginBottom: 6,
        }}
      >
        Weekly pattern
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 44 }}>
        {seasonal.map((v, i) => {
          const h = (Math.abs(v) / maxAbs) * 36;
          const positive = v >= 0;
          return (
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, position: "relative" }}
              title={`${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]}: ${v >= 0 ? "+" : ""}${v.toFixed(2)} vs avg`}
            >
              <div style={{ height: 18, display: "flex", alignItems: "flex-end", width: "100%", justifyContent: "center" }}>
                {positive && (
                  <div
                    style={{
                      width: "80%",
                      height: `${h}%`,
                      background: "#f4b942",
                      borderRadius: "2px 2px 0 0",
                    }}
                  />
                )}
              </div>
              <div style={{ height: 1, width: "100%", background: "rgba(245,230,200,0.25)" }} />
              <div style={{ height: 18, display: "flex", alignItems: "flex-start", width: "100%", justifyContent: "center" }}>
                {!positive && (
                  <div
                    style={{
                      width: "80%",
                      height: `${h}%`,
                      background: "#e07a5f",
                      borderRadius: "0 0 2px 2px",
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  fontFamily: "'Geist Mono', monospace",
                  fontSize: 9,
                  color: "rgba(245,230,200,0.5)",
                  marginTop: 2,
                }}
              >
                {labels[i]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StackedCumulativeChart({ rows, people, selectedPeople }) {
  const visible = selectedPeople
    ? people.filter((p) => selectedPeople.has(p))
    : people;
  return (
    <Panel title="The rising tide" subtitle="Stacked contributions to the group total">
      <ResponsiveContainer width="100%" height={340}>
        <AreaChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <defs>
            {visible.map((p) => {
              const i = people.indexOf(p);
              const c = colourFor(p, people);
              return (
                <linearGradient key={p} id={`stack-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c} stopOpacity={0.85} />
                  <stop offset="100%" stopColor={c} stopOpacity={0.45} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid stroke={GRID} />
          <XAxis
            dataKey="day"
            stroke={AXIS}
            tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 10 }}
            minTickGap={30}
          />
          <YAxis stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
            labelStyle={{ color: "#f5e6c8" }}
            itemSorter={(item) => -item.value}
          />
          <Legend wrapperStyle={{ fontFamily: "'Instrument Sans', sans-serif", fontSize: 12 }} />
          {visible.map((p) => {
            const i = people.indexOf(p);
            return (
              <Area
                key={p}
                type="monotone"
                dataKey={p}
                stackId="1"
                stroke={colourFor(p, people)}
                strokeWidth={1.5}
                fill={`url(#stack-grad-${i})`}
                isAnimationActive={false}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function PersonSelector({ people, selected, onToggle, onAll, onNone, onReset }) {
  return (
    <Panel title="Focus" subtitle="Pick who to show in the line & stacked charts">
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <QuickButton onClick={onReset}>top 10</QuickButton>
        <QuickButton onClick={onAll}>all</QuickButton>
        <QuickButton onClick={onNone}>none</QuickButton>
        <div
          style={{
            fontFamily: "'Geist Mono', monospace",
            fontSize: 10,
            color: "rgba(245,230,200,0.5)",
            alignSelf: "center",
            marginLeft: "auto",
          }}
        >
          {selected.size} of {people.length} selected
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {people.map((p) => {
          const isOn = selected.has(p);
          const colour = colourFor(p, people);
          return (
            <button
              key={p}
              onClick={() => onToggle(p)}
              style={{
                fontFamily: "'Instrument Sans', sans-serif",
                fontSize: 12,
                padding: "5px 11px",
                border: `1px solid ${isOn ? colour : "rgba(244,185,66,0.15)"}`,
                borderRadius: 999,
                background: isOn
                  ? `${colour}22`
                  : "rgba(255,255,255,0.02)",
                color: isOn ? "#f5e6c8" : "rgba(245,230,200,0.45)",
                cursor: "pointer",
                transition: "all 0.15s",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: isOn ? colour : "rgba(245,230,200,0.2)",
                }}
              />
              {p}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function QuickButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: "'Geist Mono', monospace",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        padding: "6px 12px",
        border: "1px solid rgba(244,185,66,0.3)",
        borderRadius: 4,
        background: "rgba(244,185,66,0.05)",
        color: "#f4b942",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ForecastChart({ forecast }) {
  if (!forecast) {
    return (
      <Panel title="The road to 10,000" subtitle="Group forecast">
        <div style={{ color: "rgba(245,230,200,0.4)", fontFamily: "'Instrument Sans', sans-serif", padding: "40px 0" }}>
          Not enough data yet to fit a trend.
        </div>
      </Panel>
    );
  }

  const { rows, etaDate, daysToTarget, currentTotal, target, dailyRate, seasonal } = forecast;
  const pct = Math.min(100, (currentTotal / target) * 100);

  const etaLabel = etaDate
    ? etaDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "—";
  const rateLabel = dailyRate > 0 ? `${dailyRate.toFixed(2)} drinks/day` : "flat or declining";

  return (
    <Panel title={`The road to ${target.toLocaleString()}`} subtitle="Group forecast · trend + weekly seasonality, 95% band">
      {/* --- Headline numbers --- */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginBottom: 18, alignItems: "flex-start" }}>
        <ForecastStat label="Current total" value={currentTotal.toLocaleString()} />
        <ForecastStat label="Trend rate" value={rateLabel} mono={dailyRate > 0} />
        <ForecastStat label="Days to target" value={daysToTarget != null ? daysToTarget.toLocaleString() : "∞"} />
        <ForecastStat label="Projected date" value={etaLabel} mono={false} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <SeasonalitySparkline seasonal={seasonal} />
        </div>
      </div>

      {/* --- Progress bar --- */}
      <div
        style={{
          height: 6,
          background: "rgba(244,185,66,0.1)",
          borderRadius: 3,
          overflow: "hidden",
          marginBottom: 24,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "linear-gradient(90deg, #f4b942, #e07a5f)",
            borderRadius: 3,
          }}
        />
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="bandGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f4b942" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#f4b942" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} />
          <XAxis
            dataKey="day"
            stroke={AXIS}
            tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 10 }}
            minTickGap={30}
          />
          <YAxis stroke={AXIS} tick={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              background: "#0e2a24",
              border: "1px solid rgba(244,185,66,0.3)",
              borderRadius: 8,
              fontFamily: "'Instrument Sans', sans-serif",
            }}
            labelStyle={{ color: "#f5e6c8" }}
            formatter={(value, name) =>
              value == null ? ["—", name] : [Math.round(value).toLocaleString(), name]
            }
          />
          <Legend wrapperStyle={{ fontFamily: "'Instrument Sans', sans-serif", fontSize: 12 }} />

          {/* Prediction band rendered as a proper range area */}
          <Area
            type="monotone"
            dataKey={(d) => (d.lower != null && d.upper != null ? [d.lower, d.upper] : [null, null])}
            stroke="none"
            fill="url(#bandGradient)"
            name="95% band"
            isAnimationActive={false}
            connectNulls
          />

          <Line
            type="monotone"
            dataKey="actual"
            stroke="#f5e6c8"
            strokeWidth={2.5}
            dot={false}
            name="Actual"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="#f4b942"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            name="Forecast"
            isAnimationActive={false}
          />
          <ReferenceLine
            y={target}
            stroke="#e07a5f"
            strokeDasharray="3 3"
            label={{
              value: `${target.toLocaleString()}`,
              fill: "#e07a5f",
              fontFamily: "'Geist Mono', monospace",
              fontSize: 11,
              position: "right",
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function ForecastStat({ label, value, mono = true }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "'Geist Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(245,230,200,0.5)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "'Geist Mono', monospace" : "'Fraunces', serif",
          fontSize: mono ? 20 : 19,
          color: "#f4b942",
          fontStyle: mono ? "normal" : "italic",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Heatmap({ grid, color, name, total }) {
  const flat = grid.flat();
  const max = Math.max(1, ...flat);
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const hours = ["0", "3", "6", "9", "12", "15", "18", "21"];

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(244,185,66,0.12)",
        borderRadius: 10,
        padding: "16px 16px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontFamily: "'Fraunces', serif",
            fontSize: 15,
            color: "#f5e6c8",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: 2,
              background: color,
              marginRight: 8,
              verticalAlign: "middle",
            }}
          />
          {name}
        </div>
        <div
          style={{
            fontFamily: "'Geist Mono', monospace",
            fontSize: 11,
            color: "rgba(245,230,200,0.55)",
          }}
        >
          {total}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "14px repeat(8, 1fr)",
          gap: 3,
          alignItems: "center",
        }}
      >
        <div />
        {hours.map((h) => (
          <div
            key={h}
            style={{
              fontFamily: "'Geist Mono', monospace",
              fontSize: 8,
              color: "rgba(245,230,200,0.4)",
              textAlign: "center",
            }}
          >
            {h}
          </div>
        ))}
        {grid.map((row, i) => (
          <React.Fragment key={i}>
            <div
              style={{
                fontFamily: "'Geist Mono', monospace",
                fontSize: 9,
                color: "rgba(245,230,200,0.45)",
                textAlign: "right",
                paddingRight: 2,
              }}
            >
              {days[i]}
            </div>
            {row.map((v, j) => {
              const intensity = v === 0 ? 0 : 0.18 + 0.82 * (v / max);
              return (
                <div
                  key={j}
                  title={`${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]} ${j*3}:00–${j*3+3}:00 · ${v} drinks`}
                  style={{
                    aspectRatio: "1",
                    background: v === 0 ? "rgba(255,255,255,0.04)" : color,
                    opacity: v === 0 ? 1 : intensity,
                    borderRadius: 3,
                    border: v === 0 ? "none" : "1px solid rgba(0,0,0,0.15)",
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function HeatmapGrid({ events, people }) {
  // Compute each person's grid and total once, then sort by total descending
  // so the heaviest drinkers appear first in the small-multiples layout.
  const entries = people
    .map((p) => {
      const grid = personHeatmap(events, p);
      const total = grid.flat().reduce((s, v) => s + v, 0);
      return { name: p, grid, total };
    })
    .sort((a, b) => b.total - a.total);

  return (
    <Panel
      title="Rhythms of the week"
      subtitle="Per-person · day × 3-hour block · ordered by total"
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 14,
        }}
      >
        {entries.map(({ name, grid, total }) => (
          <Heatmap
            key={name}
            grid={grid}
            color={colourFor(name, people)}
            name={name}
            total={total}
          />
        ))}
      </div>
    </Panel>
  );
}

function HallOfFame({ sessions, people }) {
  return (
    <Panel title="Hall of fame" subtitle="Biggest single-day sessions">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {sessions.length === 0 && (
          <div style={{ color: "rgba(245,230,200,0.4)", fontFamily: "'Instrument Sans', sans-serif" }}>
            Nothing recorded yet.
          </div>
        )}
        {sessions.map((s, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 16,
              paddingBottom: 12,
              borderBottom: i < sessions.length - 1 ? "1px dashed rgba(244,185,66,0.15)" : "none",
            }}
          >
            <div
              style={{
                fontFamily: "'Fraunces', serif",
                fontSize: 28,
                fontStyle: "italic",
                color: colourFor(s.author, people),
                width: 36,
              }}
            >
              {i + 1}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, color: "#f5e6c8" }}>{s.author}</div>
              <div
                style={{
                  fontFamily: "'Geist Mono', monospace",
                  fontSize: 11,
                  color: "rgba(245,230,200,0.5)",
                }}
              >
                {s.day}
              </div>
            </div>
            <div
              style={{
                fontFamily: "'Geist Mono', monospace",
                fontSize: 22,
                color: "#f4b942",
                fontWeight: 600,
              }}
            >
              {s.total}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ============================================================================
   6. APP
   ========================================================================== */

// Small sample dataset so the UI has something to show before any upload.
// Each row = 1 drink. Numbers are the running group total (display-only,
// not used for arithmetic). A handful of photo+number pairs are included
// to demo the dedupe behaviour. Fri/Sat are deliberately dominant so the
// weekly seasonality model has something to detect.
const SAMPLE_TEXT = `16/03/2026, 21:00 - Sam: 1
18/03/2026, 20:00 - Priya: <Media omitted>
18/03/2026, 20:00 - Priya: 2
20/03/2026, 19:30 - Jonno: <Media omitted>
20/03/2026, 19:30 - Jonno: 3
20/03/2026, 20:00 - Sam: 4
20/03/2026, 20:30 - Priya: 5
20/03/2026, 21:00 - Sam: <Media omitted>
20/03/2026, 21:01 - Sam: 6
20/03/2026, 22:00 - Jonno: 7
21/03/2026, 18:00 - Sam: 8
21/03/2026, 19:00 - Priya: <Media omitted>
21/03/2026, 19:00 - Priya: 9
21/03/2026, 20:00 - Sam: 10
21/03/2026, 21:00 - Jonno: 11
21/03/2026, 22:00 - Priya: 12
21/03/2026, 23:00 - Sam: 13
23/03/2026, 20:00 - Sam: 14
25/03/2026, 21:00 - Jonno: 15
27/03/2026, 19:00 - Priya: 16
27/03/2026, 20:00 - Sam: 17
27/03/2026, 21:00 - Priya: 18
27/03/2026, 22:00 - Jonno: 19
28/03/2026, 18:30 - Sam: 20
28/03/2026, 19:30 - Priya: 21
28/03/2026, 20:30 - Jonno: 22
28/03/2026, 21:30 - Sam: 23
28/03/2026, 22:30 - Priya: 24
31/03/2026, 20:00 - Priya: 25
02/04/2026, 21:00 - Sam: 26
03/04/2026, 19:00 - Jonno: 27
03/04/2026, 20:00 - Sam: 28
03/04/2026, 21:30 - Priya: 29
04/04/2026, 18:00 - Sam: 30
04/04/2026, 19:30 - Jonno: <Media omitted>
04/04/2026, 19:30 - Jonno: 31
04/04/2026, 20:30 - Priya: 32
04/04/2026, 22:00 - Sam: 33
08/04/2026, 21:00 - Jonno: <Media omitted>
10/04/2026, 19:00 - Sam: 34
10/04/2026, 20:00 - Priya: 35
10/04/2026, 21:00 - Jonno: 36`;

export default function BeerTracker() {
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [fileName, setFileName] = useState("sample data");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [mergePairs, setMergePairs] = useState(true);
  // Date-range leaderboard: default to 30 days ago. User can change via date input.
  const [sinceDate, setSinceDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  // Which people are visible in the line / stacked-area charts.
  // null = default (top 10 by all-time); any Set = explicit user choice.
  const [visibleOverride, setVisibleOverride] = useState(null);

  // On mount, try to fetch a bundled chat.txt from the site root. This is
  // how the hosted version works: you commit the WhatsApp export to
  // public/chat.txt in the repo, and every visitor sees the same data.
  // If the file is missing or can't be parsed, fall back to the sample.
  useEffect(() => {
    let cancelled = false;
    fetch("/chat.txt", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        // Guard: if the server returned an HTML fallback (common for SPA
        // hosts when a file is missing), don't try to parse it as a chat.
        if (text.trim().startsWith("<!")) throw new Error("not a text file");
        const lastMod = r.headers.get("last-modified");
        if (cancelled) return;
        setRawText(text);
        setFileName("live data");
        if (lastMod) setLastUpdated(new Date(lastMod));
      })
      .catch(() => {
        if (!cancelled) setFileName("sample data");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const messages = useMemo(() => parseWhatsAppExport(rawText), [rawText]);
  const events = useMemo(
    () => buildDrinkEvents(messages, { mergePairs }),
    [messages, mergePairs]
  );
  // Raw (unmerged) event count, for showing how many pairs got deduped
  const rawEventCount = useMemo(
    () => buildDrinkEvents(messages, { mergePairs: false }).length,
    [messages]
  );
  const mergedPairCount = rawEventCount - events.length;
  const people = useMemo(() => [...new Set(events.map((e) => e.author))], [events]);
  const allTime = useMemo(() => totalsByPerson(events), [events]);
  const sinceTotals = useMemo(() => {
    // Parse YYYY-MM-DD as LOCAL midnight (not UTC) to avoid timezone surprises
    // where a drink posted at 11pm Jan 31 locally ends up on Feb 1 in UTC.
    const [y, m, d] = sinceDate.split("-").map(Number);
    if (!y || !m || !d) return [];
    const cutoff = new Date(y, m - 1, d);
    return totalsByPerson(events.filter((e) => e.date >= cutoff));
  }, [events, sinceDate]);
  const cumul = useMemo(() => cumulativeSeries(events), [events]);
  const dow = useMemo(() => dayOfWeekTotals(events), [events]);
  const hod = useMemo(() => hourOfDayTotals(events), [events]);
  const sessions = useMemo(() => biggestSessions(events), [events]);
  const dailyTotals = useMemo(() => dailyCumulativeTotal(events), [events]);
  const forecast = useMemo(
    () => forecastWithSeasonality(dailyTotals, GROUP_TARGET),
    [dailyTotals]
  );

  // Default visible set = top 10 by all-time. If user has made an explicit
  // selection via the Focus panel, that overrides the default.
  const defaultVisible = useMemo(
    () => new Set(allTime.slice(0, 10).map((p) => p.name)),
    [allTime]
  );
  const visiblePeople = visibleOverride ?? defaultVisible;

  const toggleVisible = useCallback(
    (name) => {
      setVisibleOverride((prev) => {
        const base = prev ?? new Set(allTime.slice(0, 10).map((p) => p.name));
        const next = new Set(base);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    },
    [allTime]
  );
  const setVisibleAll = useCallback(() => setVisibleOverride(new Set(people)), [people]);
  const setVisibleNone = useCallback(() => setVisibleOverride(new Set()), []);
  const resetVisible = useCallback(() => setVisibleOverride(null), []);

  const onFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setRawText(String(reader.result));
    reader.readAsText(file);
  }, []);

  const totalDrinks = events.reduce((s, e) => s + e.count, 0);

  return (
    <div
      className="main-container"
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(ellipse at top, #14362e 0%, #0b1f1a 50%, #071410 100%)",
        color: "#f5e6c8",
        padding: "48px 32px 80px",
        fontFamily: "'Instrument Sans', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,500;0,700;1,500&family=Instrument+Sans:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .tt-file-label:hover { background: rgba(244,185,66,0.15) !important; }

        /* --- Layout grid (12 columns desktop, collapses on mobile) --- */
        .chart-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 20px;
        }
        .col-6  { grid-column: span 6;  min-width: 0; }
        .col-12 { grid-column: span 12; min-width: 0; }

        /* Tablets and small laptops: collapse two-column rows to one */
        @media (max-width: 900px) {
          .col-6 { grid-column: span 12; }
          .chart-grid { gap: 16px; }
        }

        /* Phones: tighten padding, stack the masthead, smaller chart panels */
        @media (max-width: 600px) {
          .main-container { padding: 28px 16px 60px !important; }
          .masthead {
            flex-direction: column !important;
            align-items: flex-start !important;
            gap: 18px !important;
            margin-bottom: 28px !important;
          }
          .masthead-controls {
            align-items: flex-start !important;
            width: 100%;
          }
          .panel { padding: 20px 18px 18px !important; }
          .panel-title { font-size: 19px !important; }
          .stat-row { gap: 12px !important; }
        }

        /* Touch devices: make tappable things at least 36px tall */
        @media (hover: none) and (pointer: coarse) {
          .tt-chip { min-height: 32px; }
          .tt-quick { min-height: 32px; }
        }
      `}</style>

      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* ---- Masthead ---- */}
        <header className="masthead" style={{ marginBottom: 40, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
          <div>
            <div
              style={{
                fontFamily: "'Geist Mono', monospace",
                fontSize: 11,
                letterSpacing: "0.3em",
                textTransform: "uppercase",
                color: "rgba(244,185,66,0.7)",
                marginBottom: 8,
              }}
            >
              Est. 2026 · The Taproom
            </div>
            <h1
              style={{
                fontFamily: "'Fraunces', serif",
                fontSize: "clamp(44px, 7vw, 84px)",
                fontWeight: 300,
                fontStyle: "italic",
                margin: 0,
                lineHeight: 0.95,
                letterSpacing: "-0.03em",
                color: "#f5e6c8",
              }}
            >
              The <span style={{ fontStyle: "normal", fontWeight: 500, color: "#f4b942" }}>Ledger</span>
            </h1>
            <div
              style={{
                marginTop: 10,
                fontFamily: "'Fraunces', serif",
                fontSize: 16,
                fontStyle: "italic",
                color: "rgba(245,230,200,0.65)",
                maxWidth: 520,
              }}
            >
              A running tally of pints, glasses and occasional regrets — parsed straight from your group chat.
            </div>
          </div>

          <div className="masthead-controls" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <label
              className="tt-file-label"
              style={{
                padding: "12px 22px",
                border: "1px solid rgba(244,185,66,0.4)",
                borderRadius: 999,
                cursor: "pointer",
                fontFamily: "'Instrument Sans', sans-serif",
                fontSize: 13,
                letterSpacing: "0.04em",
                color: "#f5e6c8",
                background: "rgba(244,185,66,0.05)",
                transition: "background 0.2s",
              }}
            >
              Upload WhatsApp export (.txt)
              <input type="file" accept=".txt" onChange={onFile} style={{ display: "none" }} />
            </label>
            <div
              style={{
                fontFamily: "'Geist Mono', monospace",
                fontSize: 10,
                color: "rgba(245,230,200,0.45)",
              }}
            >
              current: {fileName}
              {lastUpdated && (
                <>
                  {" · updated "}
                  {lastUpdated.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </>
              )}
            </div>
            <label style={{ fontFamily: "'Geist Mono', monospace", fontSize: 10, color: "rgba(245,230,200,0.5)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={mergePairs} onChange={(e) => setMergePairs(e.target.checked)} />
              merge photo+number duplicate pairs
            </label>
          </div>
        </header>

        {/* ---- Scoreboard strip ---- */}
        <div
          className="stat-row"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <StatCard label="Total drinks" value={totalDrinks.toLocaleString()} />
          <StatCard label="Drinkers" value={people.length} />
          <StatCard label="Merged pairs" value={mergedPairCount.toLocaleString()} />
          <StatCard label="Top drinker" value={allTime[0]?.name || "—"} mono={false} />
        </div>

        {/* ---- Grid of charts ---- */}
        <div className="chart-grid">
          <div className="col-6">
            <Leaderboard
              data={sinceTotals}
              title="Since"
              subtitle={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  from{" "}
                  <input
                    type="date"
                    value={sinceDate}
                    onChange={(e) => setSinceDate(e.target.value)}
                    style={{
                      background: "rgba(244,185,66,0.05)",
                      border: "1px solid rgba(244,185,66,0.3)",
                      borderRadius: 4,
                      padding: "4px 8px",
                      color: "#f5e6c8",
                      fontFamily: "'Geist Mono', monospace",
                      fontSize: 11,
                      cursor: "pointer",
                      colorScheme: "dark",
                    }}
                  />
                </span>
              }
              people={people}
            />
          </div>
          <div className="col-6">
            <Leaderboard data={allTime} title="All-time" subtitle="Since the beginning" people={people} />
          </div>
          <div className="col-12">
            <PersonSelector
              people={people}
              selected={visiblePeople}
              onToggle={toggleVisible}
              onAll={setVisibleAll}
              onNone={setVisibleNone}
              onReset={resetVisible}
            />
          </div>
          <div className="col-12">
            <CumulativeChart
              rows={cumul.rows}
              people={cumul.people}
              selectedPeople={visiblePeople}
            />
          </div>
          <div className="col-12">
            <StackedCumulativeChart
              rows={cumul.rows}
              people={cumul.people}
              selectedPeople={visiblePeople}
            />
          </div>
          <div className="col-12">
            <ForecastChart forecast={forecast} />
          </div>
          <div className="col-6">
            <DayOfWeekChart data={dow} />
          </div>
          <div className="col-6">
            <HourOfDayChart data={hod} />
          </div>
          <div className="col-12">
            <HeatmapGrid events={events} people={people} />
          </div>
          <div className="col-12">
            <HallOfFame sessions={sessions} people={people} />
          </div>
        </div>

        {/* ---- Footnote ---- */}
        <footer
          style={{
            marginTop: 48,
            paddingTop: 20,
            borderTop: "1px dashed rgba(244,185,66,0.2)",
            fontFamily: "'Geist Mono', monospace",
            fontSize: 11,
            color: "rgba(245,230,200,0.4)",
            lineHeight: 1.7,
          }}
        >
          How to export: in WhatsApp, open the group → group name → <em>Export chat</em> → <em>Without media</em> → save the .txt and drop it above.
          <br />
          Parser rules: each row in the export represents one drink — a photo <em>(&lt;Media omitted&gt;)</em> or a numeric counter update. Deleted messages are skipped. When the same person posts a photo and a number within 2 minutes of each other, they're treated as one drink and the later row is dropped. This makes the total lower than the chat's running counter, which has been ticking up once per row including double-posts. Flip the toggle above to see the raw (undeduped) count.
        </footer>
      </div>
    </div>
  );
}

function StatCard({ label, value, mono = true }) {
  return (
    <div
      style={{
        padding: "20px 22px",
        background: "rgba(244,185,66,0.04)",
        border: "1px solid rgba(244,185,66,0.15)",
        borderRadius: 12,
      }}
    >
      <div
        style={{
          fontFamily: "'Geist Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(245,230,200,0.5)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "'Geist Mono', monospace" : "'Fraunces', serif",
          fontSize: mono ? 30 : 28,
          fontWeight: mono ? 500 : 400,
          color: "#f4b942",
          fontStyle: mono ? "normal" : "italic",
        }}
      >
        {value}
      </div>
    </div>
  );
}
