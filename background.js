import { getConfig, getOriginalUrl, isBlockedNow, hostMatches, nextBoundaryAt } from './config.js';
import {
  USAGE_KEY, accountForeground, applyUsageAction, blockedDomains, nextMidnight, siteForHost, siteState,
} from './usage.js';

const ALARM_NAME = 'morning-protection-tick';
const BOUNDARY_ALARM_NAME = 'morning-protection-boundary';
const RULE_ID_BASE = 1;
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html');
const POPUP_PAGE = chrome.runtime.getURL('popup.html');
const OVERLAY_ID = 'usage-overlay';
const restoringTabs = new Map();
let syncQueue = Promise.resolve();
let ledger;
let overlayMatches;
let appliedDomains = [];
let foreground;
let focusEpoch = 0;

function getBlockedPage(url) {
  if (!url || url.split(/[?#]/, 1)[0] !== BLOCKED_PAGE) return null;
  return new URL(url);
}

function webUrl(url) {
  try {
    const page = new URL(url);
    return ['http:', 'https:'].includes(page.protocol) ? page : null;
  } catch {
    return null;
  }
}

function webHost(url) {
  return webUrl(url)?.hostname ?? null;
}

async function getLedger() {
  ledger ??= (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY] ?? {};
  return ledger;
}

async function replaceRules(domains) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = domains.map((domain, index) => ({
        id: RULE_ID_BASE + index,
        priority: 1,
        action: {
          type: 'redirect',
          // Keep the destination with the tab so it survives browser restarts and tab duplication.
          redirect: { regexSubstitution: `${BLOCKED_PAGE}#\\0` },
        },
        condition: {
          requestDomains: [domain],
          regexFilter: '^https?://.*',
          resourceTypes: ['main_frame'],
        },
      }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules,
  });
  appliedDomains = domains;
}

async function redirectOpenTabs(domains) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const host = webHost(tab.pendingUrl || tab.url);
    if (tab.id === undefined || !host || !hostMatches(host, domains)) continue;
    try {
      const current = await chrome.tabs.get(tab.id);
      const original = current.pendingUrl || current.url;
      const currentHost = webHost(original);
      if (currentHost && hostMatches(currentHost, domains)) {
        const restoreMode = current.pendingUrl ? '' : '?restore=back';
        await chrome.tabs.update(tab.id, { url: `${BLOCKED_PAGE}${restoreMode}#${original}` });
      }
    } catch (error) {
      console.warn(`Morning Protection: could not block tab ${tab.id}`, error);
    }
  }
}

async function restoreOpenTabs(domains, scheduleActive) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !getBlockedPage(tab.url)) continue;
    try {
      const current = await chrome.tabs.get(tab.id);
      const page = getBlockedPage(current.pendingUrl || current.url);
      if (!page) continue;
      const originalUrl = getOriginalUrl(page);
      if (originalUrl ? hostMatches(webHost(originalUrl), domains) : scheduleActive) continue;
      if (restoringTabs.get(tab.id) === page.href) continue;
      // Chrome resolves navigation calls before committing the new URL; concurrent requests must wait for that commit.
      restoringTabs.set(tab.id, page.href);
      // Older blocking pages have no saved URL; their browser history is the only recovery path.
      if (page.searchParams.get('restore') === 'back' || !page.hash) {
        try {
          await chrome.tabs.goBack(tab.id);
          const restored = await chrome.tabs.get(tab.id);
          if (!originalUrl || (restored.pendingUrl || restored.url) === originalUrl) continue;
        } catch (error) {
          if (!originalUrl) throw error;
        }
      }
      if (originalUrl) {
        await chrome.tabs.update(tab.id, { url: originalUrl });
      } else {
        restoringTabs.delete(tab.id);
      }
    } catch (error) {
      restoringTabs.delete(tab.id);
      console.warn(`Morning Protection: could not restore tab ${tab.id}`, error);
    }
  }
}

async function scheduleBoundary(config, now) {
  const schedule = nextBoundaryAt(config, new Date(now))?.getTime() ?? Infinity;
  const rollover = Object.keys(config.leisureLimits).length ? nextMidnight(now) : Infinity;
  const when = Math.min(schedule, rollover);
  if (Number.isFinite(when)) {
    await chrome.alarms.create(BOUNDARY_ALARM_NAME, { when });
  } else {
    await chrome.alarms.clear(BOUNDARY_ALARM_NAME);
  }
}

async function syncOverlay(config) {
  const matches = Object.keys(config.leisureLimits).sort().map((domain) => `*://*.${domain}/*`);
  const signature = matches.join('|');
  if (overlayMatches === signature) return;
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [OVERLAY_ID] });
  if (!matches.length) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_ID] });
  } else {
    const script = { id: OVERLAY_ID, js: ['overlay.js'], matches };
    if (existing) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
    // Registration affects future navigations; tabs already open need their own injection.
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(({ id, url }) => id !== undefined && siteForHost(config, webHost(url)))
      .map(({ id }) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['overlay.js'] })
        .catch((error) => console.warn(`Morning Protection: could not attach usage overlay to tab ${id}`, error))));
  }
  overlayMatches = signature;
}

async function syncState(config) {
  config ??= await getConfig();
  const usage = await getLedger();
  const now = Date.now();
  const domains = blockedDomains(config, usage, now);
  const scheduleActive = isBlockedNow(config, new Date(now));
  await scheduleBoundary(config, now);
  // Apply both restrictions before restoring tabs, so lifting one cannot bypass the other.
  await replaceRules(domains);
  await syncOverlay(config);
  if (domains.length) await redirectOpenTabs(domains);
  await restoreOpenTabs(domains, scheduleActive);
  await chrome.action.setTitle({
    title: scheduleActive ? 'Morning Protection：定时屏蔽中' : 'Morning Protection',
  });
}

function enqueue(task) {
  // Usage changes and navigation must share one order so two tabs cannot grant time twice.
  const result = syncQueue.then(task);
  syncQueue = result.catch((error) => {
    console.error('Morning Protection: could not sync protection', error);
  });
  return result;
}

function sync() {
  return enqueue(async () => { await syncState(); return true; }).catch(() => false);
}

function clearForeground() {
  foreground = undefined;
  focusEpoch++;
}

async function heartbeat(sender, config, usage) {
  const source = webUrl(sender.url);
  if (!source || sender.tab?.id === undefined || sender.frameId !== 0
    || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return null;
  const domain = siteForHost(config, source.hostname);
  if (!domain) return null;
  const epoch = focusEpoch;
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  const current = webUrl(tab?.url);
  // A same-document navigation can change the tab URL while Chrome still reports the sender's original URL.
  if (!tab?.active || tab.pendingUrl || current?.origin !== source.origin) {
    if (epoch === focusEpoch && foreground?.tabId === sender.tab.id) clearForeground();
    return siteState(config, usage, source.hostname, Date.now());
  }
  const host = current.hostname;
  const [window, idle] = await Promise.all([
    chrome.windows.get(tab.windowId).catch(() => null), chrome.idle.queryState(60),
  ]);
  const now = Date.now();
  if (epoch !== focusEpoch || !window?.focused || idle === 'locked') {
    if (epoch === focusEpoch && foreground?.tabId === tab.id) clearForeground();
    return siteState(config, usage, host, now);
  }
  if (foreground?.tabId === tab.id && foreground.domain === domain
    && foreground.documentId === sender.documentId) {
    if (accountForeground(config, usage, host, foreground.at, now)) {
      await chrome.storage.local.set({ [USAGE_KEY]: usage });
    }
  }
  if (epoch === focusEpoch) {
    foreground = { tabId: tab.id, domain, origin: current.origin, documentId: sender.documentId, at: now };
  }
  const state = siteState(config, usage, host, now);
  if (state.reason) await syncState(config);
  return state;
}

async function usageMessage(message, sender) {
  const blockedPage = getBlockedPage(sender.url);
  const popup = sender.url === POPUP_PAGE;
  if (message.type !== 'usage-heartbeat' && !popup && !blockedPage) return { ok: false };
  const config = await getConfig();
  const usage = await getLedger();
  if (message.type === 'usage-heartbeat') {
    return { ok: true, state: await heartbeat(sender, config, usage) };
  }

  const host = popup ? message.domain : webHost(getOriginalUrl(blockedPage));
  const now = Date.now();
  const state = host ? siteState(config, usage, host, now) : null;
  if (message.type === 'usage-status') {
    if (blockedPage && !(state ? state.reason : isBlockedNow(config, new Date(now)))) {
      await syncState(config);
    }
    return {
      ok: true,
      state: state ?? { reason: isBlockedNow(config, new Date(now)) ? 'schedule' : null },
    };
  }

  if (message.type !== 'usage-action') return { ok: false };
  if (blockedPage && message.action === 'leave') {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (tab.url === sender.url && (!tab.pendingUrl || getBlockedPage(tab.pendingUrl))) {
      await chrome.tabs.remove(tab.id);
    }
    return { ok: true };
  }
  const validSource = popup
    ? Object.hasOwn(config.leisureLimits, host) && message.action !== 'leisure-add'
    : state?.reason === 'study'
      ? ['study-add', 'study-finish'].includes(message.action)
      : state?.reason === 'leisure' && message.action === 'leisure-add';
  if (!validSource) return { ok: false, error: '当前页面状态已变化，请重试。' };
  const next = { ...usage };
  const error = applyUsageAction(config, next, host, message, now);
  if (error) return { ok: false, error };
  clearForeground();
  await chrome.storage.local.set({ [USAGE_KEY]: next });
  ledger = next;
  await syncState(config);
  return { ok: true };
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === BOUNDARY_ALARM_NAME) sync();
});

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (foreground?.tabId === tabId && (changes.status === 'loading'
    || (changes.url && webUrl(changes.url)?.origin !== foreground.origin))) clearForeground();
  if ((changes.url && !getBlockedPage(changes.url)) || changes.status === 'complete') {
    restoringTabs.delete(tabId);
  }
  const host = webHost(changes.url);
  if (host && hostMatches(host, appliedDomains)) sync();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (foreground?.tabId === tabId) clearForeground();
  restoringTabs.delete(tabId);
});

chrome.tabs.onActivated.addListener(clearForeground);
chrome.windows.onFocusChanged.addListener(clearForeground);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') clearForeground();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'restore-blocked-tabs' && getBlockedPage(sender.url)) {
    sync().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (['usage-heartbeat', 'usage-status', 'usage-action'].includes(message?.type)) {
    enqueue(() => usageMessage(message, sender))
      .then(sendResponse, () => sendResponse({ ok: false, error: '暂时无法更新，请重试。' }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  sync();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  sync();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    clearForeground();
    sync();
  }
});

// service worker 每次被唤醒都会执行顶层代码，用它兜住 alarm 丢失或规则与时间脱节的情况
ensureAlarm();
sync();
