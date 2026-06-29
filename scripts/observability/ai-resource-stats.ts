/**
 * AI Resource Stats — parses Claude Code transcripts in ~/.claude/projects/,
 * appends derived agent/skill invocation records to ~/.claude/observability/invocations.jsonl,
 * and emits a markdown report from the ledger.
 *
 * See ai-observability-plan.md for the design rationale.
 *
 * Run: pnpm tsx scripts/observability/ai-resource-stats.ts [options]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OBS_DIR = path.join(os.homedir(), '.claude', 'observability');
const LEDGER = path.join(OBS_DIR, 'invocations.jsonl');
const STATE = path.join(OBS_DIR, 'state.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface State {
  version: 1;
  files: Record<string, { lastOffset: number; lastMtime: number }>;
}

interface Invocation {
  ts: number;
  project: string;
  session: string;
  kind: 'agent' | 'skill';
  resource: string;
  succeeded: boolean;
  durationMs: number;
  returnChars: number;
  precedingUserText: string;
  isSidechain: boolean;
  parentTool: string | null;
  toolUseId: string;
}

interface Args {
  rebuild: boolean;
  days: number;
  project?: string;
  allProjects: boolean;
  includeNonRepos: boolean;
}

interface ProjectRule {
  name: string;
  globs: string[];
  alwaysApply: boolean;
  regexes: RegExp[];
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
    content?: Array<Record<string, unknown>> | string;
  };
  timestamp?: string | number;
  isSidechain?: boolean;
  sessionId?: string;
  parentUuid?: string | null;
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
// State load / save
// ---------------------------------------------------------------------------

function loadState(): State {
  if (!fs.existsSync(STATE)) return { version: 1, files: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf-8')) as State;
  } catch {
    console.error('warning: state.json unreadable; treating as empty');
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
// Ingest: walk new transcript ranges, derive records, append to the ledger
// ---------------------------------------------------------------------------

interface IngestStats {
  appended: number;
  filesProcessed: number;
  unparseable: number;
  unknownSamples: string[];
  toolNameCounts: Map<string, number>;
}

function ingest(state: State): IngestStats {
  fs.mkdirSync(OBS_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`warning: ${PROJECTS_DIR} does not exist`);
    return {
      appended: 0,
      filesProcessed: 0,
      unparseable: 0,
      unknownSamples: [],
      toolNameCounts: new Map(),
    };
  }

  const stats: IngestStats = {
    appended: 0,
    filesProcessed: 0,
    unparseable: 0,
    unknownSamples: [],
    toolNameCounts: new Map(),
  };
  // Accumulate records in memory, write once at the end synchronously.
  // Avoids the WriteStream-flush race that left the ledger empty on first run.
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
      const result = deriveInvocations(newLines, project);
      for (const r of result.invocations) {
        recordsToWrite.push(JSON.stringify(r));
      }
      stats.appended += result.invocations.length;
      stats.unparseable += result.unparseable;
      for (const s of result.unknownSamples) {
        if (stats.unknownSamples.length < 5) stats.unknownSamples.push(s);
      }
      for (const [name, n] of result.toolNameCounts) {
        stats.toolNameCounts.set(name, (stats.toolNameCounts.get(name) ?? 0) + n);
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
// Event derivation
// ---------------------------------------------------------------------------
//
// Events of interest in the jsonl:
//
//   Assistant tool_use:
//     { message: { role: 'assistant', content: [
//       { type: 'tool_use', id: 'toolu_xxx', name: 'Agent'|'Skill', input: {...} }
//     ]}, timestamp, isSidechain, sessionId }
//
//   User tool_result (the corresponding return):
//     { message: { role: 'user', content: [
//       { type: 'tool_result', tool_use_id: 'toolu_xxx', content: '...', is_error?: bool }
//     ]}, timestamp }
//
//   User text (for trigger-phrase capture):
//     { message: { role: 'user', content: [{ type: 'text', text: '...' }] } }
//     (or string content for older format)
//
// Everything else we skip; if we see an event whose 'type' or top-level shape
// we don't recognise, we log a sample for diagnostic purposes.

interface DeriveResult {
  invocations: Invocation[];
  unparseable: number;
  unknownSamples: string[];
  toolNameCounts: Map<string, number>;
}

function deriveInvocations(lines: string[], project: string): DeriveResult {
  const invocations: Invocation[] = [];
  const pending = new Map<
    string,
    { ts: number; resource: string; kind: 'agent' | 'skill'; isSidechain: boolean; sessionId: string }
  >();
  const recentUserText: string[] = [];
  let unparseable = 0;
  const unknownSamples: string[] = [];
  const toolNameCounts = new Map<string, number>();

  for (const line of lines) {
    let event: TranscriptEvent;
    try {
      event = JSON.parse(line) as TranscriptEvent;
    } catch {
      unparseable++;
      continue;
    }

    // Skip known non-message events silently
    if (!event.message) {
      const knownNonMessage = [
        'permission-mode',
        'summary',
        'file-history-snapshot',
        'queue-operation',
        'last-prompt',
        'system', // covers turn_duration, away_summary, etc.
        'ai-title',
        'custom-title',
      ];
      const hasAttachment = !!event.attachment;
      if (event.type && knownNonMessage.includes(event.type)) continue;
      if (hasAttachment) continue;
      // Unknown shape — sample it once
      if (unknownSamples.length < 5) unknownSamples.push(line.slice(0, 200));
      continue;
    }

    const msg = event.message;
    const ts = parseTimestamp(event.timestamp) ?? Date.now();
    const isSidechain = event.isSidechain === true;
    const sessionId = event.sessionId ?? 'unknown';
    const content = Array.isArray(msg.content) ? msg.content : null;

    if (msg.role === 'user') {
      // Tool results live in user-role messages
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const p = pending.get(block.tool_use_id);
            if (p) {
              pending.delete(block.tool_use_id);
              const resultContent =
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
              invocations.push({
                ts: p.ts,
                project,
                session: p.sessionId,
                kind: p.kind,
                resource: p.resource,
                succeeded: block.is_error !== true,
                durationMs: Math.max(0, ts - p.ts),
                returnChars: resultContent.length,
                precedingUserText: recentUserText.slice(-1)[0] ?? '',
                isSidechain: p.isSidechain,
                parentTool: null,
                toolUseId: block.tool_use_id,
              });
            }
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const t = block.text.trim();
            if (t) pushRecent(recentUserText, t.slice(0, 200));
          }
        }
      } else if (typeof msg.content === 'string') {
        const t = msg.content.trim();
        if (t) pushRecent(recentUserText, t.slice(0, 200));
      }
    } else if (msg.role === 'assistant') {
      if (!content) continue;
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const name = typeof block.name === 'string' ? block.name : '';
        // Track every tool name we see, so we can verify the filter below is correct
        if (name) toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
        if (name !== 'Agent' && name !== 'Skill' && name !== 'Task') continue;
        if (typeof block.id !== 'string') continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const kind: 'agent' | 'skill' = name === 'Skill' ? 'skill' : 'agent';
        // For agents, the resource is the subagent TYPE, not the per-invocation task
        // description. When subagent_type is omitted, the harness defaults to
        // 'general-purpose', so we do the same here. Never fall back to description —
        // that conflates agent identity with per-call task labels.
        const resource =
          (kind === 'agent'
            ? ((input.subagent_type as string) ?? (input.agent as string) ?? 'general-purpose')
            : (input.skill as string)) ?? 'unknown';
        pending.set(block.id, {
          ts,
          resource: String(resource),
          kind,
          isSidechain,
          sessionId,
        });
      }
    }
  }

  return { invocations, unparseable, unknownSamples, toolNameCounts };
}

function pushRecent(buffer: string[], text: string): void {
  buffer.push(text);
  if (buffer.length > 20) buffer.shift();
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
// Rule activations
// ---------------------------------------------------------------------------
//
// Rules don't appear as tool_use events — the harness loads them silently when
// matching files come into context. So we can't observe "rule X fired at turn Y".
//
// What we CAN observe: for each session in the current project, which files were
// touched (via Read/Edit/Write/NotebookEdit tool calls)? Then for each rule, was
// at least one of those files matched by the rule's globs? That's "this rule was
// eligible to fire" — close enough to "did fire" for spotting dead rules.

// Minimal YAML frontmatter parser (flat key:value + array support). Mirrors
// the parser in scripts/sync-ai-config.ts so the rules section can be self-contained.
function parseSimpleFrontmatter(content: string): Record<string, unknown> {
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value: string = trimmed.slice(colonIdx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') out[key] = [];
      else out[key] = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    } else if (value === 'true') {
      out[key] = true;
    } else if (value === 'false') {
      out[key] = false;
    } else {
      out[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// Glob → RegExp. Covers `**/`, `/**`, `**`, `*`, `?`. Skips exotic features
// like `{a,b}` and `[abc]` — none of our rule files use them.
function globToRegex(glob: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      regex += '(?:[^/]*/)*';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      regex += '(?:/.*)?';
      i += 3;
    } else if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        regex += '.*';
        i += 2;
      } else {
        regex += '[^/]*';
        i++;
      }
    } else if (glob[i] === '?') {
      regex += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(glob[i])) {
      regex += '\\' + glob[i];
      i++;
    } else {
      regex += glob[i];
      i++;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

function loadProjectRules(repoCwd: string): ProjectRule[] {
  const rulesDir = path.join(repoCwd, '.ai', 'rules');
  if (!fs.existsSync(rulesDir)) return [];
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
  const rules: ProjectRule[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(rulesDir, file), 'utf-8');
    const fm = parseSimpleFrontmatter(raw);
    const name = path.basename(file, '.md');
    const globs = Array.isArray(fm.globs) ? (fm.globs as string[]) : [];
    const alwaysApply = fm.alwaysApply === true;
    rules.push({ name, globs, alwaysApply, regexes: globs.map(globToRegex) });
  }
  return rules;
}

// Normalise a tool-call file path to repo-relative POSIX form so it matches
// the globs declared in rule frontmatter (e.g. "apps/fs-app/src/**/*.tsx").
function normalizePath(filePath: string, repoCwd: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const cwdNorm = repoCwd.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.toLowerCase().startsWith(cwdNorm.toLowerCase() + '/')) {
    return normalized.slice(cwdNorm.length + 1);
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) return null;
  // Already relative (e.g. "apps/fs-app/src/foo.ts")
  return normalized;
}

const FILE_TOUCHING_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
const FILE_PATH_INPUT_KEYS = ['file_path', 'notebook_path', 'path'];

function extractTouchedFiles(lines: string[], repoCwd: string): Set<string> {
  const files = new Set<string>();
  for (const line of lines) {
    let event: TranscriptEvent;
    try {
      event = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue;
    }
    const msg = event.message;
    if (!msg || msg.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : null;
    if (!content) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const name = typeof block.name === 'string' ? block.name : '';
      if (!FILE_TOUCHING_TOOLS.has(name)) continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      for (const key of FILE_PATH_INPUT_KEYS) {
        const v = input[key];
        if (typeof v === 'string') {
          const norm = normalizePath(v, repoCwd);
          if (norm) files.add(norm);
        }
      }
    }
  }
  return files;
}

interface RuleActivationResult {
  activations: Map<string, Set<string>>;
  totalSessions: number;
  sessionsWithoutTouches: number;
}

function computeRuleActivations(
  projectSlug: string,
  rules: ProjectRule[],
  repoCwd: string,
  windowStart: number
): RuleActivationResult {
  const activations = new Map<string, Set<string>>();
  for (const r of rules) activations.set(r.name, new Set());

  const projectDir = path.join(PROJECTS_DIR, projectSlug);
  if (!fs.existsSync(projectDir)) {
    return { activations, totalSessions: 0, sessionsWithoutTouches: 0 };
  }

  let totalSessions = 0;
  let sessionsWithoutTouches = 0;

  for (const file of fs.readdirSync(projectDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, file);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < windowStart) continue;

    const sessionId = path.basename(file, '.jsonl');
    totalSessions++;

    const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean);
    const touched = extractTouchedFiles(lines, repoCwd);
    if (touched.size === 0) sessionsWithoutTouches++;

    for (const rule of rules) {
      if (rule.alwaysApply) {
        activations.get(rule.name)!.add(sessionId);
        continue;
      }
      for (const f of touched) {
        if (rule.regexes.some((r) => r.test(f))) {
          activations.get(rule.name)!.add(sessionId);
          break;
        }
      }
    }
  }

  return { activations, totalSessions, sessionsWithoutTouches };
}

function emitRuleActivationsTable(
  rules: ProjectRule[],
  activations: Map<string, Set<string>>,
  totalSessions: number,
  sessionsWithoutTouches: number,
  repoCwd: string
): void {
  console.log(`\n## Rule activations\n`);
  console.log(
    `Rules loaded from \`${path.join(repoCwd, '.ai', 'rules')}\`. ` +
      `${totalSessions} session(s) in window (${sessionsWithoutTouches} touched no files — read-only/conversational).`
  );
  console.log('');
  console.log(`| Rule | Type | Globs | Sessions matched | % |`);
  console.log(`|------|------|-------|-----------------:|---:|`);
  const sorted = [...rules].sort(
    (a, b) => (activations.get(b.name)?.size ?? 0) - (activations.get(a.name)?.size ?? 0)
  );
  for (const rule of sorted) {
    const count = activations.get(rule.name)?.size ?? 0;
    const pct = totalSessions > 0 ? Math.round((100 * count) / totalSessions) : 0;
    const type = rule.alwaysApply ? 'alwaysApply' : 'scoped';
    const globsStr = rule.alwaysApply ? '—' : rule.globs.join(', ');
    console.log(`| ${rule.name} | ${type} | ${truncate(globsStr, 60)} | ${count} | ${pct}% |`);
  }
  console.log('');
  console.log(
    `_Note: "matched" means the rule's globs would have matched at least one file touched in the session — i.e. the rule was eligible to fire. It does not confirm the harness actually injected the rule's content._`
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function readLedger(): Invocation[] {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean);
  const out: Invocation[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Invocation);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function emitReport(records: Invocation[], args: Args): void {
  const windowStart = Date.now() - args.days * 86400_000;
  const projectFilter = args.allProjects ? null : args.project ?? cwdSlug();

  let filtered = records.filter(
    (r) => r.ts >= windowStart && (!projectFilter || r.project === projectFilter)
  );

  // Repo filter — default ON; opt out with --include-non-repos
  const excludedProjects = new Map<string, number>();
  if (!args.includeNonRepos) {
    const before = filtered.length;
    filtered = filtered.filter((r) => {
      if (isProjectIncluded(r.project)) return true;
      excludedProjects.set(r.project, (excludedProjects.get(r.project) ?? 0) + 1);
      return false;
    });
    if (before !== filtered.length) {
      console.error(
        `Excluded ${before - filtered.length} invocations from ${excludedProjects.size} non-repo project(s) — use --include-non-repos to keep them.`
      );
    }
  }

  console.log(`# AI Resource Stats\n`);
  console.log(`- Window: last ${args.days} days (since ${new Date(windowStart).toISOString()})`);
  console.log(`- Scope: ${projectFilter ?? 'all projects'}`);
  console.log(`- Repo filter: ${args.includeNonRepos ? 'OFF (all projects)' : 'ON (.git/.github/package.json required)'}`);
  console.log(`- Total invocations in window: ${filtered.length}`);
  console.log(`- Ledger total records: ${records.length}\n`);

  if (excludedProjects.size > 0) {
    console.log(`## Excluded non-repo projects\n`);
    console.log(`| Project slug | Resolved cwd | Invocations excluded |`);
    console.log(`|--------------|--------------|---------------------:|`);
    for (const [slug, n] of Array.from(excludedProjects.entries()).sort((a, b) => b[1] - a[1])) {
      const cwd = slugToCwd(slug) ?? '_(could not resolve)_';
      console.log(`| \`${slug}\` | \`${cwd}\` | ${n} |`);
    }
    console.log('');
  }

  if (filtered.length === 0) {
    console.log('_No invocations in the window._');
    return;
  }

  // ---- By resource -----------------------------------------------------
  const groups = new Map<string, Invocation[]>();
  for (const r of filtered) {
    const key = `${r.kind}/${r.resource}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  console.log(`## By resource\n`);
  console.log(`| Kind | Resource | Invocations | Success | Avg return (chars) | Avg duration (ms) | Top trigger |`);
  console.log(`|------|----------|------------:|--------:|-------------------:|------------------:|-------------|`);
  for (const [key, group] of sorted) {
    const [kind, resource] = key.split('/');
    const n = group.length;
    const success = group.filter((g) => g.succeeded).length;
    const successPct = Math.round((100 * success) / n);
    const avgChars = Math.round(group.reduce((s, g) => s + g.returnChars, 0) / n);
    const avgMs = Math.round(group.reduce((s, g) => s + g.durationMs, 0) / n);
    const trigger = mostRecentTrigger(group);
    console.log(
      `| ${kind} | ${resource} | ${n} | ${successPct}% | ${avgChars} | ${avgMs} | ${truncate(trigger, 60)} |`
    );
  }

  // ---- Sidechain breakdown --------------------------------------------
  const top = filtered.filter((r) => !r.isSidechain).length;
  const side = filtered.length - top;
  console.log(`\n## Top-level vs sidechain\n`);
  console.log(`- Top-level invocations: ${top}`);
  console.log(`- Sidechain (nested) invocations: ${side}`);

  // ---- Daily volume ----------------------------------------------------
  const byDay = new Map<string, number>();
  for (const r of filtered) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  console.log(`\n## Daily volume\n`);
  console.log(`| Day | Invocations |`);
  console.log(`|-----|------------:|`);
  for (const [day, n] of Array.from(byDay.entries()).sort()) {
    console.log(`| ${day} | ${n} |`);
  }

  // ---- Rule activations (single-project scope only) -------------------
  if (projectFilter) {
    const repoCwd = slugToCwd(projectFilter);
    if (!repoCwd) {
      console.log(
        `\n_(Skipping rule activations: could not resolve cwd for slug \`${projectFilter}\`.)_`
      );
    } else {
      const rules = loadProjectRules(repoCwd);
      if (rules.length === 0) {
        console.log(
          `\n_(Skipping rule activations: no \`.ai/rules/\` directory found at \`${repoCwd}\`.)_`
        );
      } else {
        const result = computeRuleActivations(projectFilter, rules, repoCwd, windowStart);
        emitRuleActivationsTable(
          rules,
          result.activations,
          result.totalSessions,
          result.sessionsWithoutTouches,
          repoCwd
        );
      }
    }
  } else {
    console.log(
      `\n_(Skipping rule activations: rules are per-project. Re-run without \`--all-projects\` to see them for the current project.)_`
    );
  }
}

function mostRecentTrigger(group: Invocation[]): string {
  for (let i = group.length - 1; i >= 0; i--) {
    if (group[i].precedingUserText.trim()) return group[i].precedingUserText;
  }
  return '(none captured)';
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/[\r\n]+/g, ' ');
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.rebuild) {
    console.error(`Rebuilding: removing ${LEDGER} and ${STATE}`);
    fs.rmSync(LEDGER, { force: true });
    fs.rmSync(STATE, { force: true });
  }

  const state = loadState();
  console.error(`Loaded state: ${Object.keys(state.files).length} files tracked`);

  const ingestStats = ingest(state);
  console.error(
    `Ingested ${ingestStats.appended} new invocations from ${ingestStats.filesProcessed} files`
  );
  if (ingestStats.unparseable > 0) {
    console.error(`Skipped ${ingestStats.unparseable} unparseable line(s)`);
  }
  if (ingestStats.unknownSamples.length > 0) {
    console.error(`Sample unknown event shapes (first ${ingestStats.unknownSamples.length}):`);
    for (const s of ingestStats.unknownSamples) console.error(`  ${s}`);
  }
  if (ingestStats.toolNameCounts.size > 0) {
    const sorted = Array.from(ingestStats.toolNameCounts.entries()).sort((a, b) => b[1] - a[1]);
    console.error(`Tool names seen in assistant messages (all projects):`);
    for (const [name, n] of sorted) console.error(`  ${name}: ${n}`);
  }

  saveState(state);

  const records = readLedger();
  emitReport(records, args);
}

main();
