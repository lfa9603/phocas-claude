/**
 * AI Resource Stats — parses Claude Code transcripts in ~/.claude/projects/,
 * derives per-message token usage + USD cost, attributes each session to a Jira
 * ticket, and emits the aggregated data as JSON:
 *
 *   1. Cost per session            — what each session cost, by model + cache tier
 *   2. Sessions aggregated per Jira — total spend grouped by ticket tag
 *   3. Cost by model + daily cost
 *
 * This module computes DATA ONLY. It does not render tables or format numbers —
 * stdout is the raw `ReportData` object as JSON, and a consuming agent owns all
 * presentation. The `buildReportData()` function is exported so an agent can
 * import and call it directly instead of shelling out.
 *
 * The ledger at ~/.claude/observability/usage.jsonl is built incrementally
 * (offset-tracked per transcript file), so re-runs only process new data.
 *
 * Run: pnpm tsx scripts/observability/ai-resource-stats.ts [options] > data.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OBS_DIR = path.join(os.homedir(), '.claude', 'observability');
const LEDGER = path.join(OBS_DIR, 'usage.jsonl');
const STATE = path.join(OBS_DIR, 'usage-state.json');
// Authoritative session→ticket ledger written by the branch-derived hooks.
const TICKET_LEDGER = path.join(OBS_DIR, 'session-tickets.jsonl');

// ---------------------------------------------------------------------------
// Pricing — USD per token. Sourced from the Anthropic pricing reference
// (claude-api skill, cached 2026-05). Base input/output rates per model; cache
// read = 0.1× input, cache write = 1.25× input (5-minute TTL) / 2× input (1-hour).
// Match is by substring on the model id so dated/suffixed variants still resolve.
// ---------------------------------------------------------------------------

interface ModelPrice {
  input: number; // USD per input token
  output: number; // USD per output token
}

const PER_MTOK = (n: number) => n / 1_000_000;

const PRICING: Array<{ match: string; price: ModelPrice }> = [
  { match: 'fable', price: { input: PER_MTOK(10), output: PER_MTOK(50) } },
  { match: 'opus', price: { input: PER_MTOK(5), output: PER_MTOK(25) } },
  { match: 'sonnet', price: { input: PER_MTOK(3), output: PER_MTOK(15) } },
  { match: 'haiku', price: { input: PER_MTOK(1), output: PER_MTOK(5) } },
];

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;

function priceFor(model: string): ModelPrice | null {
  const lower = model.toLowerCase();
  for (const { match, price } of PRICING) {
    if (lower.includes(match)) return price;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface State {
  version: 1;
  files: Record<string, { lastOffset: number; lastMtime: number }>;
}

/**
 * One record per assistant message that reported usage. Token counts are raw;
 * cost is derived at report time so a pricing change re-prices the whole ledger
 * without a rebuild.
 */
interface UsageRecord {
  ts: number;
  project: string;
  session: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  branch: string | null;
  ticket: string | null; // derived from `branch` (e.g. FS-5198), or null
}

interface Args {
  rebuild: boolean;
  days: number;
  project?: string;
  allProjects: boolean;
  includeNonRepos: boolean;
}

/**
 * The Claude Code jsonl event schema is not publicly documented. We parse what
 * we recognise and skip the rest. `any` is unavoidable here — no upstream type
 * exists.
 */
interface TranscriptEvent {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usage?: any;
  };
  timestamp?: string | number;
  sessionId?: string;
  gitBranch?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachment?: any;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = { rebuild: false, days: 30, allProjects: false, includeNonRepos: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rebuild') args.rebuild = true;
    else if (a === '--days') args.days = parseInt(argv[++i], 10);
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--all-projects') args.allProjects = true;
    else if (a === '--include-non-repos') args.includeNonRepos = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage: pnpm tsx scripts/observability/ai-resource-stats.ts [options]

Reports Claude Code cost per session and sessions aggregated per Jira ticket.

Options:
  --rebuild              Wipe the ledger and re-derive from current transcripts
  --days N               Report window in days (default: 30)
  --project SLUG         Limit report to one project (default: current cwd slug)
  --all-projects         Report across all projects under ~/.claude/projects/
  --include-non-repos    Include projects that aren't git repos (default: exclude)
  -h, --help             Show this message`);
}

function cwdSlug(): string {
  return process.cwd().replace(/[:\\/]/g, '-');
}

// ---------------------------------------------------------------------------
// Repo filter — resolve a project slug back to its on-disk cwd, then check
// whether that cwd looks like a real project (has .git, .github, or package.json).
//
// Slug encoding is lossy: '\' and ':' both become '-', and original dirnames can
// also contain '-'. So we enumerate candidate paths and pick the first that exists.
// ---------------------------------------------------------------------------

const slugToCwdCache = new Map<string, string | null>();
const isRealRepoCache = new Map<string, boolean>();

function slugToCwd(slug: string): string | null {
  if (slugToCwdCache.has(slug)) return slugToCwdCache.get(slug) ?? null;

  // Must start with a drive letter followed by '--' (the ':\' encoding).
  if (!/^[A-Za-z]--/.test(slug)) {
    slugToCwdCache.set(slug, null);
    return null;
  }
  // '---' or longer would come from a literal ' - ' (e.g. 'OneDrive - Phocas'). Skip — too ambiguous to decode reliably.
  if (/---/.test(slug)) {
    slugToCwdCache.set(slug, null);
    return null;
  }

  const drive = slug[0];
  const rest = slug.slice(3);
  const parts = rest.split('-');

  // Enumerate every interpretation of "is this dash a path separator or a literal dash within a segment name?"
  // 2^(n-1) combinations where n = number of parts. Bounded in practice.
  const maxCombos = 1 << Math.max(0, parts.length - 1);
  for (let mask = 0; mask < maxCombos; mask++) {
    const segments: string[] = [parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if ((mask >> (i - 1)) & 1) {
        segments[segments.length - 1] += '-' + parts[i];
      } else {
        segments.push(parts[i]);
      }
    }
    const candidate = `${drive}:\\${segments.join('\\')}`;
    if (fs.existsSync(candidate)) {
      slugToCwdCache.set(slug, candidate);
      return candidate;
    }
  }

  slugToCwdCache.set(slug, null);
  return null;
}

function isRealRepo(cwd: string): boolean {
  if (isRealRepoCache.has(cwd)) return isRealRepoCache.get(cwd) ?? false;
  const result =
    fs.existsSync(path.join(cwd, '.git')) ||
    fs.existsSync(path.join(cwd, '.github')) ||
    fs.existsSync(path.join(cwd, 'package.json'));
  isRealRepoCache.set(cwd, result);
  return result;
}

function isProjectIncluded(slug: string): boolean {
  const cwd = slugToCwd(slug);
  if (!cwd) return false;
  return isRealRepo(cwd);
}

// ---------------------------------------------------------------------------
// Ticket derivation — pull a Jira tag (e.g. FS-5198) from a git branch name.
// ---------------------------------------------------------------------------

function ticketFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = branch.match(/[A-Z]{2,}-\d+/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// State load / save
// ---------------------------------------------------------------------------

function loadState(): State {
  if (!fs.existsSync(STATE)) return { version: 1, files: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf-8')) as State;
  } catch {
    console.error('warning: usage-state.json unreadable; treating as empty');
    return { version: 1, files: {} };
  }
}

function saveState(state: State): void {
  fs.mkdirSync(OBS_DIR, { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

// ---------------------------------------------------------------------------
// Ingest: walk new transcript ranges, derive usage records, append to the ledger
// ---------------------------------------------------------------------------

interface IngestStats {
  appended: number;
  filesProcessed: number;
  unparseable: number;
  modelsSeen: Map<string, number>;
  unpricedModels: Set<string>;
}

function ingest(state: State): IngestStats {
  fs.mkdirSync(OBS_DIR, { recursive: true });
  const stats: IngestStats = {
    appended: 0,
    filesProcessed: 0,
    unparseable: 0,
    modelsSeen: new Map(),
    unpricedModels: new Set(),
  };
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`warning: ${PROJECTS_DIR} does not exist`);
    return stats;
  }

  // Accumulate in memory, write once at the end synchronously — avoids the
  // WriteStream-flush race that can leave the ledger empty on first run.
  const recordsToWrite: string[] = [];

  // Ingest from ALL projects — the ledger is complete; filtering happens at report time.
  for (const project of fs.readdirSync(PROJECTS_DIR)) {
    const projDir = path.join(PROJECTS_DIR, project);
    if (!fs.statSync(projDir).isDirectory()) continue;

    for (const file of fs.readdirSync(projDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(projDir, file);
      const key = `${project}/${file}`;
      const stat = fs.statSync(full);
      const prev = state.files[key];

      // No new data
      if (prev && stat.mtimeMs <= prev.lastMtime && stat.size === prev.lastOffset) continue;

      // Truncation / rewrite: reset
      const startOffset = !prev || stat.size < prev.lastOffset ? 0 : prev.lastOffset;

      const newLines = readFromOffset(full, startOffset);
      const result = deriveUsage(newLines, project);
      for (const r of result.records) {
        recordsToWrite.push(JSON.stringify(r));
      }
      stats.appended += result.records.length;
      stats.unparseable += result.unparseable;
      for (const [m, n] of result.modelsSeen) {
        stats.modelsSeen.set(m, (stats.modelsSeen.get(m) ?? 0) + n);
        if (m !== '<synthetic>' && !priceFor(m)) stats.unpricedModels.add(m);
      }
      stats.filesProcessed++;

      state.files[key] = { lastOffset: stat.size, lastMtime: stat.mtimeMs };
    }
  }

  if (recordsToWrite.length > 0) {
    fs.appendFileSync(LEDGER, recordsToWrite.join('\n') + '\n');
  }

  return stats;
}

function readFromOffset(file: string, offset: number): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return [];
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf-8').split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Usage derivation
// ---------------------------------------------------------------------------
//
// Assistant messages carry a `usage` block and a `model`:
//   { message: { role: 'assistant', model: 'claude-opus-4-8', usage: {
//       input_tokens, output_tokens, cache_read_input_tokens,
//       cache_creation_input_tokens,
//       cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } } },
//     timestamp, sessionId, gitBranch }
//
// `gitBranch` is a top-level field on most events; we carry the last-seen branch
// forward within a file so usage events that omit it still get attributed.

interface DeriveResult {
  records: UsageRecord[];
  unparseable: number;
  modelsSeen: Map<string, number>;
}

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function deriveUsage(lines: string[], project: string): DeriveResult {
  const records: UsageRecord[] = [];
  const modelsSeen = new Map<string, number>();
  let unparseable = 0;
  // Last-seen git branch, per session, so usage events lacking gitBranch inherit it.
  const lastBranch = new Map<string, string>();

  for (const line of lines) {
    let event: TranscriptEvent;
    try {
      event = JSON.parse(line) as TranscriptEvent;
    } catch {
      unparseable++;
      continue;
    }

    const sessionId = event.sessionId ?? 'unknown';
    if (typeof event.gitBranch === 'string' && event.gitBranch) {
      lastBranch.set(sessionId, event.gitBranch);
    }

    const msg = event.message;
    if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

    const model = typeof msg.model === 'string' ? msg.model : 'unknown';
    modelsSeen.set(model, (modelsSeen.get(model) ?? 0) + 1);
    if (model === '<synthetic>') continue; // synthetic messages have no cost

    const usage = msg.usage;
    const cacheCreation = usage.cache_creation ?? {};
    // Prefer the explicit 5m/1h breakdown; fall back to treating all cache
    // creation as the default 5-minute TTL when the breakdown is absent.
    let write5m = num(cacheCreation.ephemeral_5m_input_tokens);
    let write1h = num(cacheCreation.ephemeral_1h_input_tokens);
    if (write5m === 0 && write1h === 0) {
      write5m = num(usage.cache_creation_input_tokens);
    }

    const ts = parseTimestamp(event.timestamp) ?? Date.now();
    const branch = lastBranch.get(sessionId) ?? null;

    records.push({
      ts,
      project,
      session: sessionId,
      model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWrite5mTokens: write5m,
      cacheWrite1hTokens: write1h,
      branch,
      ticket: ticketFromBranch(branch),
    });
  }

  return { records, unparseable, modelsSeen };
}

function parseTimestamp(ts: string | number | undefined): number | null {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return isNaN(n) ? null : n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

function recordCost(r: UsageRecord): number {
  const price = priceFor(r.model);
  if (!price) return 0;
  return (
    r.inputTokens * price.input +
    r.outputTokens * price.output +
    r.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER +
    r.cacheWrite5mTokens * price.input * CACHE_WRITE_5M_MULTIPLIER +
    r.cacheWrite1hTokens * price.input * CACHE_WRITE_1H_MULTIPLIER
  );
}

// ---------------------------------------------------------------------------
// Authoritative session→ticket ledger (written by the branch hooks)
// ---------------------------------------------------------------------------

function loadTicketLedger(): Map<string, string> {
  // session → ticket. Last entry per session wins (most recent branch state).
  const map = new Map<string, string>();
  if (!fs.existsSync(TICKET_LEDGER)) return map;
  const lines = fs.readFileSync(TICKET_LEDGER, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { session?: string; ticket?: string };
      if (e.session && e.ticket) map.set(e.session, e.ticket);
    } catch {
      // skip corrupt line
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function readLedger(): UsageRecord[] {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean);
  const out: UsageRecord[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as UsageRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

interface SessionAgg {
  session: string;
  project: string;
  resolvedTicket: string; // the one ticket the whole session is counted against
  // Latest branch-derived ticket seen on this session's records, and its ts.
  // Used as the fallback when the session isn't in the authoritative hook ledger.
  branchTicket: string | null;
  branchTicketTs: number;
  models: Set<string>;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  firstTs: number;
  lastTs: number;
}

// ---------------------------------------------------------------------------
// Report data — the structured result. This module computes data only; all
// presentation (tables, formatting, currency/token rendering) is the
// consuming agent's job. Numbers are raw (cost in USD, tokens as counts,
// timestamps as epoch ms); model ids and project slugs are unabbreviated.
// ---------------------------------------------------------------------------

export interface SessionData {
  session: string;
  project: string;
  ticket: string;
  models: string[];
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  firstTs: number;
  lastTs: number;
}

export interface TicketData {
  ticket: string;
  sessions: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  lastTs: number;
}

export interface ModelData {
  model: string;
  messages: number;
  cost: number;
}

export interface DailyData {
  day: string; // YYYY-MM-DD (UTC)
  cost: number;
}

export interface ExcludedProject {
  slug: string;
  cwd: string | null;
  records: number;
}

/**
 * Ingestion + sanity info, carried IN the JSON rather than printed to stderr so
 * stdout stays pure JSON for the consuming agent. `unpricedModels` is the one
 * the agent should surface — those messages counted as $0, so the total is low.
 */
export interface Diagnostics {
  filesTracked: number;
  newRecords: number;
  filesProcessed: number;
  unparseable: number;
  modelsSeen: { model: string; count: number }[];
  unpricedModels: string[];
}

export interface ReportData {
  windowDays: number;
  sinceMs: number;
  scope: string; // project slug, or "all projects"
  repoFilter: 'on' | 'off';
  totalCost: number;
  recordsInWindow: number;
  ledgerTotal: number;
  excludedProjects: ExcludedProject[];
  tickets: TicketData[]; // sorted by cost desc
  sessions: SessionData[]; // sorted by cost desc
  byModel: ModelData[]; // sorted by cost desc
  daily: DailyData[]; // sorted by day asc
  diagnostics?: Diagnostics;
}

/**
 * Pure: derives every metric the report needs from the ledger and returns it
 * as a plain object. No I/O, no console output, no formatting. The agent that
 * calls this owns all presentation.
 */
export function buildReportData(records: UsageRecord[], args: Args): ReportData {
  const windowStart = Date.now() - args.days * 86400_000;
  const projectFilter = args.allProjects ? null : args.project ?? cwdSlug();
  const ticketLedger = loadTicketLedger();

  let filtered = records.filter(
    (r) => r.ts >= windowStart && (!projectFilter || r.project === projectFilter)
  );

  // Repo filter — default ON; opt out with --include-non-repos
  const excludedCounts = new Map<string, number>();
  if (!args.includeNonRepos) {
    filtered = filtered.filter((r) => {
      if (isProjectIncluded(r.project)) return true;
      excludedCounts.set(r.project, (excludedCounts.get(r.project) ?? 0) + 1);
      return false;
    });
  }
  const excludedProjects: ExcludedProject[] = Array.from(excludedCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([slug, records]) => ({ slug, cwd: slugToCwd(slug), records }));

  const base: ReportData = {
    windowDays: args.days,
    sinceMs: windowStart,
    scope: projectFilter ?? 'all projects',
    repoFilter: args.includeNonRepos ? 'off' : 'on',
    totalCost: 0,
    recordsInWindow: filtered.length,
    ledgerTotal: records.length,
    excludedProjects,
    tickets: [],
    sessions: [],
    byModel: [],
    daily: [],
  };

  if (filtered.length === 0) return base;

  base.totalCost = filtered.reduce((s, r) => s + recordCost(r), 0);

  // ---- Aggregate per session ------------------------------------------
  // A session is attributed to ONE ticket and counted against it in full.
  // The common workflow is: start on `main`, ask Claude to cut a Jira branch,
  // then work — so early messages happen on `main`. Counting per-record would
  // strand those under "(untracked)". Instead we resolve a single ticket per
  // session (the hook ledger's last entry, else the most-recent branch the
  // session was on) and attribute the whole session's cost to it.
  const sessions = new Map<string, SessionAgg>();
  for (const r of filtered) {
    let s = sessions.get(r.session);
    if (!s) {
      s = {
        session: r.session,
        project: r.project,
        resolvedTicket: '(untracked)',
        branchTicket: null,
        branchTicketTs: -1,
        models: new Set(),
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        firstTs: r.ts,
        lastTs: r.ts,
      };
      sessions.set(r.session, s);
    }
    s.models.add(r.model);
    s.messages++;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cacheReadTokens += r.cacheReadTokens;
    s.cacheWriteTokens += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
    s.cost += recordCost(r);
    s.firstTs = Math.min(s.firstTs, r.ts);
    s.lastTs = Math.max(s.lastTs, r.ts);
    // Track the latest branch the session switched to (ignores main / null).
    if (r.ticket && r.ts >= s.branchTicketTs) {
      s.branchTicket = r.ticket;
      s.branchTicketTs = r.ts;
    }
  }
  // Resolve each session's single ticket: authoritative hook ledger wins, else
  // the most-recent Jira branch the session checked out, else untracked.
  for (const s of sessions.values()) {
    s.resolvedTicket = ticketLedger.get(s.session) ?? s.branchTicket ?? '(untracked)';
  }

  // ---- Sessions aggregated per Jira ticket ----------------------------
  // Whole-session attribution: every session contributes its full totals to its
  // single resolved ticket.
  const byTicket = new Map<string, TicketData>();
  for (const s of sessions.values()) {
    let t = byTicket.get(s.resolvedTicket);
    if (!t) {
      t = { ticket: s.resolvedTicket, sessions: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, lastTs: s.lastTs };
      byTicket.set(s.resolvedTicket, t);
    }
    t.sessions++;
    t.cost += s.cost;
    t.inputTokens += s.inputTokens;
    t.outputTokens += s.outputTokens;
    t.cacheTokens += s.cacheReadTokens + s.cacheWriteTokens;
    t.lastTs = Math.max(t.lastTs, s.lastTs);
  }
  base.tickets = Array.from(byTicket.values()).sort((a, b) => b.cost - a.cost);

  // ---- Per-session rows -----------------------------------------------
  base.sessions = Array.from(sessions.values())
    .sort((a, b) => b.cost - a.cost)
    .map((s) => ({
      session: s.session,
      project: s.project,
      ticket: s.resolvedTicket,
      models: Array.from(s.models),
      messages: s.messages,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      cost: s.cost,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
    }));

  // ---- Cost by model --------------------------------------------------
  const byModel = new Map<string, ModelData>();
  for (const r of filtered) {
    const m = byModel.get(r.model) ?? { model: r.model, messages: 0, cost: 0 };
    m.cost += recordCost(r);
    m.messages++;
    byModel.set(r.model, m);
  }
  base.byModel = Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);

  // ---- Daily cost -----------------------------------------------------
  const byDay = new Map<string, number>();
  for (const r of filtered) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + recordCost(r));
  }
  base.daily = Array.from(byDay.entries())
    .sort()
    .map(([day, cost]) => ({ day, cost }));

  return base;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.rebuild) {
    fs.rmSync(LEDGER, { force: true });
    fs.rmSync(STATE, { force: true });
  }

  const state = loadState();
  const filesTracked = Object.keys(state.files).length;
  const ingestStats = ingest(state);
  saveState(state);

  const records = readLedger();
  const data = buildReportData(records, args);

  // Carry diagnostics inside the JSON so stdout is a single pure-JSON document —
  // nothing on stderr to interleave, whatever the caller's shell does with fd2.
  data.diagnostics = {
    filesTracked,
    newRecords: ingestStats.appended,
    filesProcessed: ingestStats.filesProcessed,
    unparseable: ingestStats.unparseable,
    modelsSeen: Array.from(ingestStats.modelsSeen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([model, count]) => ({ model, count })),
    unpricedModels: Array.from(ingestStats.unpricedModels),
  };

  // stdout = the structured report data (JSON), and nothing else. All
  // presentation is the consuming agent's responsibility.
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

main();
