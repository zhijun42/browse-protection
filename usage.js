import { hostMatches, isBlockedNow, nextBoundaryAt } from './config.js';

export const MINUTE_MS = 60_000;
export const USAGE_KEY = 'siteUsage';
const MAX_HEARTBEAT_GAP_MS = 3_500;

export function dayKey(now) {
  const date = new Date(now);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
}

export function nextMidnight(now) {
  return new Date(now).setHours(24, 0, 0, 0);
}

export function entryFor(ledger, domain, now) {
  const entry = ledger[domain];
  const day = dayKey(now);
  return entry?.day === day
    ? entry
    : { day, usedMs: 0, extraMs: 0, study: entry?.study ?? null };
}

export function siteForHost(config, host) {
  return Object.keys(config.leisureLimits).find((domain) => hostMatches(host, [domain]));
}

export function siteState(config, ledger, host, now) {
  const domain = siteForHost(config, host);
  const entry = domain ? entryFor(ledger, domain, now) : null;
  const remainingMs = entry
    ? Math.max(0, config.leisureLimits[domain] * MINUTE_MS + entry.extraMs - entry.usedMs)
    : null;
  let reason = null;
  if (isBlockedNow(config, new Date(now)) && hostMatches(host, config.domains)) reason = 'schedule';
  else if (entry?.study && entry.study.usedMs >= entry.study.plannedMs) reason = 'study';
  else if (entry && !entry.study && remainingMs === 0) reason = 'leisure';
  return {
    domain: domain ?? null, reason, remainingMs, study: entry?.study ?? null,
    usedMs: entry?.usedMs ?? 0, extraMs: entry?.extraMs ?? 0,
    limitMinutes: domain ? config.leisureLimits[domain] : null,
  };
}

export function blockedDomains(config, ledger, now) {
  const domains = isBlockedNow(config, new Date(now)) ? [...config.domains] : [];
  for (const domain of Object.keys(config.leisureLimits)) {
    if (siteState(config, ledger, domain, now).reason) domains.push(domain);
  }
  return [...new Set(domains)];
}

export function accountForeground(config, ledger, host, from, to) {
  if (to <= from || to - from > MAX_HEARTBEAT_GAP_MS) return false;
  let changed = false;
  while (from < to) {
    const state = siteState(config, ledger, host, from);
    if (!state.domain || state.reason) break;
    const scheduleBoundary = hostMatches(host, config.domains)
      ? nextBoundaryAt(config, new Date(from))?.getTime()
      : null;
    const until = Math.min(to, nextMidnight(from), scheduleBoundary ?? to);
    const elapsed = until - from;
    const entry = entryFor(ledger, state.domain, from);
    ledger[state.domain] = state.study
      ? {
          ...entry,
          study: {
            ...state.study,
            usedMs: Math.min(state.study.plannedMs, state.study.usedMs + elapsed),
          },
        }
      : { ...entry, usedMs: entry.usedMs + Math.min(state.remainingMs, elapsed) };
    changed = true;
    from = until;
  }
  return changed;
}

export function applyUsageAction(config, ledger, host, { action, minutes }, now) {
  const state = siteState(config, ledger, host, now);
  if (!state.domain) return '此网站没有设置娱乐额度。';
  if (state.reason === 'schedule') return '定时屏蔽期间不能开启学习或续时。';
  const entry = entryFor(ledger, state.domain, now);
  if (action === 'study-add') {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return '请输入 1 至 1440 之间的整数分钟。';
    }
    const study = entry.study ?? { usedMs: 0, plannedMs: 0 };
    ledger[state.domain] = {
      ...entry, study: { ...study, plannedMs: study.plannedMs + minutes * MINUTE_MS },
    };
  } else if (action === 'study-finish') {
    if (!entry.study) return '本次学习已结束。';
    ledger[state.domain] = { ...entry, study: null };
  } else if (action === 'leisure-add') {
    if (state.reason !== 'leisure' || ![10, 20].includes(minutes)) {
      return '娱乐额度用完后才能选择再看 10 或 20 分钟。';
    }
    ledger[state.domain] = { ...entry, extraMs: entry.extraMs + minutes * MINUTE_MS };
  } else {
    return '不支持的操作。';
  }
  return null;
}
