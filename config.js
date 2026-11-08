export const DEFAULTS = {
  enabled: true,
  blockStart: '22:00',
  blockEnd: '10:30',
  domains: ['xiaohongshu.com', 'amap.com', 'douban.com'],
  leisureLimits: { 'xiaohongshu.com': 40 },
};

export async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...stored,
    domains: normalizeDomains(stored.domains),
    leisureLimits: normalizeLeisureLimits(stored.leisureLimits ?? DEFAULTS.leisureLimits),
  };
}

export function normalizeLeisureLimits(input) {
  const limits = {};
  const candidates = Object.entries(input ?? {})
    .map(([raw, minutes]) => [normalizeDomains([raw])[0] ?? '', minutes])
    .sort(([a], [b]) => a.length - b.length);
  for (const [domain, minutes] of candidates) {
    if (!domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) continue;
    if (!hostMatches(domain, Object.keys(limits))) limits[domain] = minutes;
  }
  return limits;
}

export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const cleaned = list
    .map((raw) =>
      String(raw)
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, ''),
    )
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return [...new Set(cleaned)];
}

export function toMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function isBlockedNow(config, now = new Date()) {
  if (!config.enabled) return false;
  const start = toMinutes(config.blockStart);
  const end = toMinutes(config.blockEnd);
  if (start === null || end === null || start === end) return false;
  const cur = minutesOfDay(now);
  // 当窗口跨过午夜时（例如 22:00 -> 10:00），条件要写成"或"
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function nextUnlockAt(config, now = new Date()) {
  const end = toMinutes(config.blockEnd);
  if (end === null) return null;
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(Math.floor(end / 60), end % 60);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

export function nextBoundaryAt(config, now = new Date()) {
  if (!config.enabled) return null;
  const start = toMinutes(config.blockStart);
  const end = toMinutes(config.blockEnd);
  if (start === null || end === null || start === end) return null;
  const boundaries = [start, end].map((minutes) => {
    const target = new Date(now);
    target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  });
  return new Date(Math.min(...boundaries.map((target) => target.getTime())));
}

export function hostMatches(host, domains) {
  const normalized = String(host).toLowerCase();
  return domains.some((d) => normalized === d || normalized.endsWith('.' + d));
}

export function getOriginalUrl(blockedPage) {
  try {
    const original = new URL(blockedPage.hash.slice(1));
    return ['http:', 'https:'].includes(original.protocol) ? original.href : null;
  } catch {
    return null;
  }
}
