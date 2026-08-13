export interface JsonSanitizerBudget {
  entries: number;
}

export interface SanitizedMppProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  hint?: string;
  details?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PROBLEM_TYPE_LENGTH = 2_048;
const MAX_PROBLEM_TITLE_LENGTH = 512;
const MAX_PROBLEM_DETAIL_LENGTH = 8_192;
const MAX_PROBLEM_HINT_LENGTH = 2_048;
const MAX_PROBLEM_DIAGNOSTICS_LENGTH = 16_384;
const MAX_PROBLEM_DIAGNOSTICS_DEPTH = 16;
const MAX_PROBLEM_DIAGNOSTICS_ENTRIES = 256;
const PROBLEM_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'extensions',
  'hint',
  'details',
  'challengeId',
]);

export function sanitizeJsonValue(
  value: unknown,
  depth: number,
  budget: JsonSanitizerBudget,
  maxDepth: number,
): unknown {
  if (depth > maxDepth) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= MAX_PROBLEM_DIAGNOSTICS_LENGTH ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > budget.entries) return undefined;
    const nextBudget = { entries: budget.entries - value.length };
    const out: unknown[] = [];
    for (const item of value) {
      const itemBudget = { entries: nextBudget.entries };
      const sanitized = sanitizeJsonValue(item, depth + 1, itemBudget, maxDepth);
      if (sanitized === undefined) return undefined;
      nextBudget.entries = itemBudget.entries;
      out.push(sanitized);
    }
    budget.entries = nextBudget.entries;
    return out;
  }
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([key]) => !UNSAFE_OBJECT_KEYS.has(key));
  if (entries.length > budget.entries) return undefined;
  const nextBudget = { entries: budget.entries - entries.length };
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const itemBudget = { entries: nextBudget.entries };
    const sanitized = sanitizeJsonValue(item, depth + 1, itemBudget, maxDepth);
    if (sanitized === undefined) continue;
    nextBudget.entries = itemBudget.entries;
    out[key] = sanitized;
  }
  if (entries.length > 0 && Object.keys(out).length === 0) return undefined;
  budget.entries = nextBudget.entries;
  return out;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeMppProblemDetail(body: unknown): SanitizedMppProblemDetail | undefined {
  if (!isPlainRecord(body)) return undefined;
  const source = Object.hasOwn(body, 'problem') ? body['problem'] : body;
  if (!isPlainRecord(source)) return undefined;
  const { type, title, status, detail, hint, details, extensions } = source;
  if (
    !isBoundedString(type, MAX_PROBLEM_TYPE_LENGTH) ||
    !isBoundedString(title, MAX_PROBLEM_TITLE_LENGTH) ||
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !isBoundedString(detail, MAX_PROBLEM_DETAIL_LENGTH)
  ) {
    return undefined;
  }

  const sanitized: SanitizedMppProblemDetail = { type, title, status, detail };
  if (isBoundedString(hint, MAX_PROBLEM_HINT_LENGTH)) sanitized.hint = hint;
  const sanitizedDetails = sanitizeProblemRecord(details, false);
  if (sanitizedDetails !== undefined) sanitized.details = sanitizedDetails;
  const sanitizedExtensions = sanitizeProblemRecord(extensions, true);
  if (sanitizedExtensions !== undefined) sanitized.extensions = sanitizedExtensions;
  return sanitized;
}

function sanitizeProblemRecord(value: unknown, filterReservedKeys: boolean): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const sanitized = sanitizeJsonValue(
    value,
    0,
    { entries: MAX_PROBLEM_DIAGNOSTICS_ENTRIES },
    MAX_PROBLEM_DIAGNOSTICS_DEPTH,
  );
  if (!isPlainRecord(sanitized)) return undefined;
  const filtered = filterReservedKeys
    ? Object.fromEntries(Object.entries(sanitized).filter(([key]) => !PROBLEM_EXTENSION_KEYS.has(key)))
    : sanitized;
  if (Object.keys(filtered).length === 0) return undefined;
  try {
    if (JSON.stringify(filtered).length > MAX_PROBLEM_DIAGNOSTICS_LENGTH) return undefined;
  } catch {
    return undefined;
  }
  return filtered;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
