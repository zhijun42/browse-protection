import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, isBlockedNow, nextBoundaryAt } from '../config.js';
import { dayKey, MINUTE_MS } from '../usage.js';

const BLOCKED_PAGE = 'chrome-extension://test-extension/blocked.html';
const POPUP_PAGE = 'chrome-extension://test-extension/popup.html';
const XHS = 'https://www.xiaohongshu.com/explore/example#comments';
const RealDate = Date;
let importNumber = 0;

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    },
  };
}

async function startBackground({ now = '2026-10-15T10:30:00', config = {}, tabs = [], usage = {} } = {}) {
  const state = {
    config: { ...DEFAULTS, leisureLimits: {}, ...config },
    now: new RealDate(now).getTime(),
    usage: structuredClone(usage),
    focused: true,
    idle: 'active',
    tabs: new Map(tabs.map((tab) => [tab.id, { ...tab }])),
    rules: [],
    calls: [],
    alarms: new Map(),
    syncs: 0,
  };
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  };
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onInstalled: event(), onStartup: event(), onMessage: event(),
    },
    storage: {
      sync: { get: async () => state.config },
      local: {
        get: async () => ({ siteUsage: structuredClone(state.usage) }),
        set: async ({ siteUsage }) => { state.usage = structuredClone(siteUsage); },
      },
      onChanged: event(),
    },
    declarativeNetRequest: {
      getDynamicRules: async () => state.rules,
      updateDynamicRules: async ({ addRules }) => {
        state.rules = addRules;
        state.calls.push(['rules', addRules.length]);
      },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(), onActivated: event(),
      query: async () => [...state.tabs.values()].map((tab) => ({ ...tab })),
      get: async (id) => {
        const tab = state.tabs.get(id);
        if (!tab || tab.closed) throw new Error('No tab with id');
        return { ...tab };
      },
      goBack: async (id) => {
        const tab = state.tabs.get(id);
        state.calls.push(['back', id]);
        if (!tab.previousUrl) throw new Error('Cannot go back');
        assert.equal(state.rules.length, 0, 'Rules must be removed before restoration');
        if (state.deferBack) {
          tab.pendingUrl = tab.previousUrl;
          return;
        }
        if (state.wrongBack) {
          tab.pendingUrl = 'about:blank';
          return;
        }
        tab.url = tab.previousUrl;
        delete tab.pendingUrl;
        await chrome.tabs.onUpdated.emit(id, { url: tab.url });
      },
      update: async (id, { url }) => {
        const tab = state.tabs.get(id);
        if (!tab || tab.closed) throw new Error('No tab with id');
        state.calls.push(['update', id, url]);
        tab.previousUrl = tab.url;
        tab.url = url;
        delete tab.pendingUrl;
        await chrome.tabs.onUpdated.emit(id, { url: tab.url });
      },
      remove: async (id) => {
        state.tabs.delete(id);
        await chrome.tabs.onRemoved.emit(id);
      },
    },
    windows: { onFocusChanged: event(), get: async () => ({ focused: state.focused }) },
    idle: { onStateChanged: event(), queryState: async () => state.idle },
    scripting: {
      getRegisteredContentScripts: async () => state.script ? [state.script] : [],
      registerContentScripts: async ([script]) => { state.script = script; },
      updateContentScripts: async ([script]) => { state.script = script; },
      unregisterContentScripts: async () => { state.script = undefined; },
      executeScript: async () => [],
    },
    alarms: {
      get: async (name) => state.alarms.get(name),
      create: async (name, info) => state.alarms.set(name, info),
      clear: async (name) => state.alarms.delete(name),
      onAlarm: event(),
    },
    action: { setTitle: async () => { state.syncs++; } },
  };
  globalThis.chrome = chrome;
  await import(`../background.js?test=${++importNumber}`);
  state.flush = async (expected = state.syncs + 1) => {
    for (let attempt = 0; attempt < 30 && state.syncs < expected; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(state.syncs >= expected, `Expected ${expected} completed syncs, observed ${state.syncs}`);
  };
  await state.flush(1);
  state.chrome = chrome;
  state.send = (message, sender) => new Promise((resolve, reject) => {
    chrome.runtime.onMessage.emit(message, sender, resolve).catch(reject);
  });
  state.heartbeat = (id = 1) => state.send(
    { type: 'usage-heartbeat' },
    { url: state.tabs.get(id).url, tab: { id }, frameId: 0 },
  );
  state.popup = (action, minutes) => state.send(
    { type: 'usage-action', domain: 'xiaohongshu.com', action, minutes },
    { url: POPUP_PAGE },
  );
  state.blocked = (action, minutes) => state.send(
    action ? { type: 'usage-action', action, minutes } : { type: 'usage-status' },
    { url: state.tabs.get(1).url, tab: { id: 1 }, frameId: 0 },
  );
  return state;
}

test('the overnight window ends at 10:30 and schedules the next boundary', () => {
  assert.equal(isBlockedNow(DEFAULTS, new RealDate('2026-10-15T10:29:59')), true);
  assert.equal(isBlockedNow(DEFAULTS, new RealDate('2026-10-15T10:30:00')), false);
  for (const [now, expected] of [
    ['2026-10-15T09:00:00', '2026-10-15T10:30:00'],
    ['2026-10-15T10:30:00', '2026-10-15T22:00:00'],
    ['2026-10-15T23:00:00', '2026-10-16T10:30:00'],
  ]) {
    assert.equal(nextBoundaryAt(DEFAULTS, new RealDate(now)).getTime(), new RealDate(expected).getTime());
  }
  assert.equal(nextBoundaryAt({ ...DEFAULTS, enabled: false }), null);
  assert.equal(nextBoundaryAt({ ...DEFAULTS, blockStart: 'invalid' }), null);
  assert.equal(nextBoundaryAt({ ...DEFAULTS, blockStart: '10:30' }), null);
});

test('daytime windows schedule their start and end correctly', () => {
  const config = { ...DEFAULTS, blockStart: '08:00', blockEnd: '10:30' };
  for (const [now, expected] of [
    ['2026-10-15T07:00:00', '2026-10-15T08:00:00'],
    ['2026-10-15T08:00:00', '2026-10-15T10:30:00'],
    ['2026-10-15T11:00:00', '2026-10-16T08:00:00'],
  ]) {
    assert.equal(nextBoundaryAt(config, new RealDate(now)).getTime(), new RealDate(expected).getTime());
  }
});

test('blocking open tabs keeps their full URL and browser-back restoration mode', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/one?xsec_token=a%2Fb#comments';
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [
      { id: 1, url: original }, { id: 2, url: 'https://example.com/' },
    ] });
    assert.equal(state.tabs.get(1).url, `${BLOCKED_PAGE}?restore=back#${original}`);
    assert.equal(state.tabs.get(2).url, 'https://example.com/');
    assert.equal(state.rules.length, DEFAULTS.domains.length);
    assert.equal(state.rules[0].action.redirect.regexSubstitution, `${BLOCKED_PAGE}#\\0`);
    assert.equal(state.alarms.get('morning-protection-boundary').when, new RealDate('2026-10-15T10:30:00').getTime());
  } finally { globalThis.Date = RealDate; }
});

test('unlock restores multiple old and new pages while preserving unrelated tabs', async () => {
  try {
    const first = 'https://www.xiaohongshu.com/explore/one?xsec_token=a%2Fb#comments';
    const second = 'https://www.douban.com/people/two/';
    const third = 'https://www.amap.com/search?query=%E5%85%AC%E5%8F%B8';
    const state = await startBackground({ tabs: [
      { id: 1, url: `${BLOCKED_PAGE}?restore=back#${first}`, previousUrl: first, active: true, pinned: true },
      { id: 2, url: BLOCKED_PAGE, previousUrl: second, active: false, windowId: 2 },
      { id: 3, url: `${BLOCKED_PAGE}#${third}`, previousUrl: 'https://example.com/' },
      { id: 4, url: 'https://example.com/' },
      { id: 5, url: 'chrome-extension://other-extension/blocked.html', previousUrl: 'https://example.org/' },
    ] });
    assert.equal(state.tabs.get(1).url, first);
    assert.equal(state.tabs.get(2).url, second);
    assert.equal(state.tabs.get(3).url, third);
    assert.equal(state.tabs.get(4).url, 'https://example.com/');
    assert.equal(state.tabs.get(5).url, 'chrome-extension://other-extension/blocked.html');
    assert.equal(state.tabs.get(1).active, true);
    assert.equal(state.tabs.get(1).pinned, true);
    assert.deepEqual(state.calls.slice(0, 4), [['rules', 0], ['back', 1], ['back', 2], ['update', 3, third]]);
  } finally { globalThis.Date = RealDate; }
});

test('a duplicated page without history restores through its saved URL', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/copied';
    const state = await startBackground({ tabs: [{ id: 1, url: `${BLOCKED_PAGE}?restore=back#${original}` }] });
    assert.equal(state.tabs.get(1).url, original);
    assert.deepEqual(state.calls, [['rules', 0], ['back', 1], ['update', 1, original]]);
  } finally { globalThis.Date = RealDate; }
});

test('the end alarm restores tabs and a subsequent tick does not navigate back twice', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/one';
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [{ id: 1, url: original }] });
    state.config.enabled = false;
    await state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-boundary' });
    await state.flush(2);
    assert.equal(state.tabs.get(1).url, original);
    await state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-tick' });
    await state.flush(3);
    assert.equal(state.calls.filter(([type]) => type === 'back').length, 1);
    assert.equal(state.alarms.has('morning-protection-boundary'), false);
  } finally { globalThis.Date = RealDate; }
});

test('startup after a missed unlock restores existing blocked pages', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/after-sleep';
    const state = await startBackground({ now: '2026-10-15T11:15:00' });
    state.tabs.set(7, { id: 7, url: `${BLOCKED_PAGE}#${original}` });
    await state.chrome.runtime.onStartup.emit();
    await state.flush(2);
    assert.equal(state.tabs.get(7).url, original);
  } finally { globalThis.Date = RealDate; }
});

test('closed tabs and tabs already navigating elsewhere do not stop restoration', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  try {
    const original = 'https://www.xiaohongshu.com/explore/one';
    const state = await startBackground({ tabs: [
      { id: 1, url: BLOCKED_PAGE, closed: true },
      { id: 2, url: `${BLOCKED_PAGE}#${original}`, pendingUrl: 'https://example.com/new' },
      { id: 3, url: `${BLOCKED_PAGE}#${original}` },
    ] });
    assert.equal(state.tabs.get(2).pendingUrl, 'https://example.com/new');
    assert.equal(state.tabs.get(3).url, original);
    assert.equal(state.calls.some(([type, id]) => type === 'update' && id === 2), false);
    assert.equal(warning.mock.calls.length, 1);
    assert.match(warning.mock.calls[0].arguments[0], /could not restore tab 1/);
  } finally { globalThis.Date = RealDate; }
});

test('failed rule updates report failure and later requests can recover', async (t) => {
  const errorLog = t.mock.method(console, 'error', () => {});
  try {
    const state = await startBackground();
    const originalUpdate = state.chrome.declarativeNetRequest.updateDynamicRules;
    state.chrome.declarativeNetRequest.updateDynamicRules = async () => { throw new Error('Rule update failed'); };
    let response;
    await state.chrome.runtime.onMessage.emit({ type: 'restore-blocked-tabs' }, { url: BLOCKED_PAGE }, (value) => { response = value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(response, { ok: false });
    assert.equal(errorLog.mock.calls.length, 1);
    state.chrome.declarativeNetRequest.updateDynamicRules = originalUpdate;
    await state.chrome.runtime.onMessage.emit({ type: 'restore-blocked-tabs' }, { url: BLOCKED_PAGE }, (value) => { response = value; });
    await state.flush(2);
    assert.deepEqual(response, { ok: true });
  } finally { globalThis.Date = RealDate; }
});

test('unsafe saved URLs are not opened', async () => {
  try {
    const state = await startBackground({ tabs: [{ id: 1, url: `${BLOCKED_PAGE}#javascript:alert(1)` }] });
    assert.equal(state.calls.some(([type]) => type === 'update' || type === 'back'), false);
  } finally { globalThis.Date = RealDate; }
});

test('requests cannot bypass an active block and unrelated senders are ignored', async () => {
  try {
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [{ id: 1, url: BLOCKED_PAGE }] });
    let response;
    await state.chrome.runtime.onMessage.emit({ type: 'restore-blocked-tabs' }, { url: BLOCKED_PAGE }, (value) => { response = value; });
    await state.flush(2);
    assert.deepEqual(response, { ok: true });
    assert.equal(state.calls.some(([type]) => type === 'back'), false);
    await state.chrome.runtime.onMessage.emit({ type: 'restore-blocked-tabs' }, { url: 'https://example.com/' }, () => assert.fail('Must ignore sender'));
    assert.equal(state.syncs, 2);
  } finally { globalThis.Date = RealDate; }
});

test('overlapping settings and alarm events restore each tab once', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/one';
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [{ id: 1, url: original }] });
    state.config.enabled = false;
    await Promise.all([
      state.chrome.storage.onChanged.emit({ enabled: { newValue: false } }, 'sync'),
      state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-tick' }),
      state.chrome.runtime.onStartup.emit(),
    ]);
    await state.flush(4);
    assert.equal(state.calls.filter(([type]) => type === 'back').length, 1);
    assert.equal(state.tabs.get(1).url, original);
  } finally { globalThis.Date = RealDate; }
});

test('back navigation is issued once while Chrome has not yet committed the original URL', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/slow';
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [{ id: 1, url: original }] });
    state.deferBack = true;
    state.config.enabled = false;
    await state.chrome.storage.onChanged.emit({ enabled: { newValue: false } }, 'sync');
    await state.flush(2);
    await state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-tick' });
    await state.flush(3);
    assert.equal(state.calls.filter(([type]) => type === 'back').length, 1);
    state.tabs.get(1).url = original;
    delete state.tabs.get(1).pendingUrl;
    await state.chrome.tabs.onUpdated.emit(1, { url: original, status: 'complete' });
    await state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-tick' });
    await state.flush(4);
    assert.equal(state.calls.filter(([type]) => type === 'back').length, 1);
  } finally { globalThis.Date = RealDate; }
});

test('a successful back call to a different page falls back to the saved original URL', async () => {
  try {
    const original = 'https://www.xiaohongshu.com/explore/one';
    const state = await startBackground({ now: '2026-10-15T09:00:00', tabs: [{ id: 1, url: original }] });
    state.wrongBack = true;
    state.config.enabled = false;
    await state.chrome.storage.onChanged.emit({ enabled: { newValue: false } }, 'sync');
    await state.flush(2);
    assert.equal(state.tabs.get(1).url, original);
    assert.equal(state.calls.filter(([type]) => type === 'back').length, 1);
    assert.equal(state.calls.filter(([type, , url]) => type === 'update' && url === original).length, 1);
  } finally { globalThis.Date = RealDate; }
});

const limitConfig = { leisureLimits: { 'xiaohongshu.com': 40, 'youtube.com': 25 } };
const domain = 'xiaohongshu.com';
const date = '2026-10-15T10:30:00';
const today = dayKey(new RealDate(date));
const siteTab = { id: 1, url: XHS, active: true, windowId: 1 };

test('a same-document post URL change keeps leisure and study counting from the original sender', async () => {
  try {
    const feed = 'https://www.xiaohongshu.com/explore';
    const state = await startBackground({ config: limitConfig, tabs: [{ ...siteTab, url: feed }] });
    const sender = { url: feed, tab: { id: 1 }, frameId: 0, documentId: 'feed', documentLifecycle: 'active' };
    const tick = () => state.send({ type: 'usage-heartbeat' }, sender);
    const changePage = async (url) => {
      state.tabs.get(1).url = url;
      await state.chrome.tabs.onUpdated.emit(1, { url });
    };

    await tick();
    await changePage(XHS);
    state.now += 1000;
    assert.equal((await tick()).state.usedMs, 1000);
    assert.equal((await state.popup('study-add', 30)).ok, true);
    await tick();
    await changePage('https://www.xiaohongshu.com/explore/video?from=feed');
    state.now += 1000;
    assert.equal((await tick()).state.study.usedMs, 1000);
    await changePage(feed);
    state.now += 1000;
    const { state: afterBack } = await tick();
    assert.equal(afterBack.study.usedMs, 2000);
    assert.equal(afterBack.usedMs, 1000);
  } finally { globalThis.Date = RealDate; }
});

test('heartbeats from a previous origin, a cached document or a subframe cannot charge the site', async () => {
  try {
    const state = await startBackground({ config: limitConfig, tabs: [siteTab] });
    const sender = { url: XHS, tab: { id: 1 }, frameId: 0, documentId: 'original', documentLifecycle: 'active' };
    const tick = (overrides) => state.send({ type: 'usage-heartbeat' }, { ...sender, ...overrides });
    await tick();
    state.now += 1000;
    const otherOrigin = 'https://app.xiaohongshu.com/explore/another';
    state.tabs.get(1).url = otherOrigin;
    await state.chrome.tabs.onUpdated.emit(1, { url: otherOrigin });
    await tick();
    state.now += 1000;
    await tick();
    assert.equal(state.usage[domain], undefined);

    const active = { url: otherOrigin, documentId: 'new-document' };
    await tick(active);
    state.now += 1000;
    await tick({ ...active, documentLifecycle: 'cached' });
    await tick({ ...active, frameId: 1 });
    assert.equal(state.usage[domain], undefined);
    assert.equal((await tick(active)).state.usedMs, 1000);
  } finally { globalThis.Date = RealDate; }
});

test('study accumulates in the focused site only and resumes after reference browsing, lock and sleep', async () => {
  try {
    const state = await startBackground({ config: limitConfig, tabs: [
      siteTab, { id: 2, url: 'https://example.com/anatomy', active: false, windowId: 1 },
      { id: 3, url: 'https://www.youtube.com/watch?v=lesson', active: false, windowId: 1 },
    ] });
    assert.equal((await state.popup('study-add', 30)).ok, true);
    await state.heartbeat();
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.study.usedMs, 1000);
    state.tabs.get(1).active = false;
    await state.chrome.tabs.onActivated.emit({ tabId: 2 });
    state.now += 8 * MINUTE_MS;
    await state.heartbeat();
    state.tabs.get(1).active = true;
    await state.chrome.tabs.onActivated.emit({ tabId: 1 });
    assert.equal((await state.heartbeat()).state.study.usedMs, 1000);
    state.idle = 'idle';
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.study.usedMs, 2000, 'reading without input counts');
    state.idle = 'locked';
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.study.usedMs, 2000);
    state.idle = 'active';
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.study.usedMs, 2000);
    state.now += 60 * MINUTE_MS;
    assert.equal((await state.heartbeat()).state.study.usedMs, 2000, 'sleep gap must not be charged');
    state.focused = false;
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.study.usedMs, 2000);
    state.focused = true;
    state.tabs.get(1).active = false;
    state.tabs.get(3).active = true;
    await state.chrome.tabs.onActivated.emit({ tabId: 3 });
    await state.heartbeat(3);
    state.now += 1000;
    assert.equal((await state.heartbeat(3)).state.remainingMs, 25 * MINUTE_MS - 1000);
    assert.equal(state.usage[domain].usedMs, 0);
    assert.equal(state.usage[domain].study.usedMs, 2000);
    assert.deepEqual(state.script.matches, ['*://*.xiaohongshu.com/*', '*://*.youtube.com/*']);
  } finally { globalThis.Date = RealDate; }
});

test('study deadline pauses both clocks, extends the same session, and restores the old leisure balance', async () => {
  try {
    const state = await startBackground({ config: limitConfig, tabs: [siteTab], usage: {
      [domain]: { day: today, usedMs: 15 * MINUTE_MS, extraMs: 0,
        study: { plannedMs: 30 * MINUTE_MS, usedMs: 30 * MINUTE_MS - 1000 } },
    } });
    await state.heartbeat();
    state.now += 2000;
    const { state: stopped } = await state.heartbeat();
    assert.equal(stopped.reason, 'study');
    assert.equal(stopped.study.usedMs, 30 * MINUTE_MS);
    assert.equal(state.tabs.get(1).url, `${BLOCKED_PAGE}?restore=back#${XHS}`);
    state.now += 15 * MINUTE_MS;
    const { state: waiting } = await state.blocked();
    assert.equal(waiting.study.usedMs, 30 * MINUTE_MS);
    assert.equal(waiting.usedMs, 15 * MINUTE_MS);
    assert.equal((await state.blocked('study-add', 20)).ok, true);
    assert.equal(state.tabs.get(1).url, XHS);
    assert.deepEqual((await state.heartbeat()).state.study, {
      plannedMs: 50 * MINUTE_MS, usedMs: 30 * MINUTE_MS,
    });
    assert.equal((await state.popup('study-finish')).ok, true);
    assert.equal((await state.heartbeat()).state.remainingMs, 25 * MINUTE_MS);
  } finally { globalThis.Date = RealDate; }
});

test('the leisure stop is shared by tabs and each grant ends at the new cumulative total', async () => {
  try {
    const state = await startBackground({ config: limitConfig, tabs: [
      siteTab, { id: 2, url: 'https://xiaohongshu.com/explore/other', active: false, windowId: 1 },
    ], usage: {
      [domain]: { day: today, usedMs: 40 * MINUTE_MS - 1000, extraMs: 0, study: null },
    } });
    await state.heartbeat();
    state.now += 1000;
    assert.equal((await state.heartbeat()).state.usedMs, 40 * MINUTE_MS);
    const sender = { url: state.tabs.get(2).url, tab: { id: 2 }, frameId: 0 };
    assert.match(sender.url, /blocked\.html/);
    const [first, second] = await Promise.all([
      state.blocked('leisure-add', 20),
      state.send({ type: 'usage-action', action: 'leisure-add', minutes: 10 }, sender),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(state.usage[domain].extraMs, 20 * MINUTE_MS);
    assert.equal(state.tabs.get(1).url, XHS);
    await state.heartbeat();
    for (let seconds = 0; seconds < 20 * 60; seconds += 2) {
      state.now += 2000;
      await state.heartbeat();
    }
    const { state: stopped } = await state.blocked();
    assert.equal(stopped.reason, 'leisure');
    assert.equal(stopped.usedMs, 60 * MINUTE_MS);
    assert.equal((await state.blocked('leisure-add', 10)).ok, true);
    assert.equal((await state.heartbeat()).state.remainingMs, 10 * MINUTE_MS);
  } finally { globalThis.Date = RealDate; }
});

test('starting study can reopen an exhausted site; finishing at the study stop returns to the leisure stop', async () => {
  try {
    const state = await startBackground({ config: limitConfig, tabs: [siteTab], usage: {
      [domain]: { day: today, usedMs: 40 * MINUTE_MS, extraMs: 0, study: null },
    } });
    assert.equal((await state.blocked()).state.reason, 'leisure');
    assert.equal((await state.popup('study-add', 1)).ok, true);
    assert.equal(state.tabs.get(1).url, XHS);
    await state.heartbeat();
    for (let i = 0; i < 30; i++) {
      state.now += 2000;
      await state.heartbeat();
    }
    assert.equal((await state.blocked()).state.reason, 'study');
    assert.equal((await state.blocked('study-finish')).ok, true);
    assert.equal((await state.blocked()).state.reason, 'leisure');
    assert.equal(state.usage[domain].usedMs, 40 * MINUTE_MS);
    assert.equal((await state.blocked('leave')).ok, true);
    assert.equal(state.tabs.has(1), false);
  } finally { globalThis.Date = RealDate; }
});

test('morning unlock restores other sites but leaves an exhausted site blocked', async () => {
  try {
    const state = await startBackground({ now: '2026-10-15T10:29:59', config: limitConfig,
      tabs: [siteTab, { id: 2, url: 'https://www.douban.com/book/123' }], usage: {
        [domain]: { day: today, usedMs: 40 * MINUTE_MS, extraMs: 0, study: null },
      },
    });
    assert.equal((await state.blocked()).state.reason, 'schedule');
    assert.equal((await state.popup('study-add', 30)).ok, false);
    assert.equal((await state.blocked('leisure-add', 20)).ok, false);
    state.now += 1000;
    const expected = state.syncs + 1;
    await state.chrome.alarms.onAlarm.emit({ name: 'morning-protection-boundary' });
    await state.flush(expected);
    assert.equal((await state.blocked()).state.reason, 'leisure');
    assert.equal(state.tabs.get(2).url, 'https://www.douban.com/book/123');
    assert.deepEqual(state.rules.map((rule) => rule.condition.requestDomains), [[domain]]);
  } finally { globalThis.Date = RealDate; }
});

test('midnight drops prior leisure and extra time while a current study session survives restart', async () => {
  try {
    const state = await startBackground({ now: '2026-10-16T00:00:00',
      config: { ...limitConfig, enabled: false }, tabs: [siteTab],
      usage: { [domain]: { day: today, usedMs: 60 * MINUTE_MS, extraMs: 20 * MINUTE_MS,
        study: { plannedMs: 30 * MINUTE_MS, usedMs: 18 * MINUTE_MS } } },
    });
    const { state: resumed } = await state.heartbeat();
    assert.equal(resumed.study.usedMs, 18 * MINUTE_MS);
    assert.equal(resumed.usedMs, 0);
    assert.equal(resumed.extraMs, 0);
    assert.equal((await state.popup('study-finish')).ok, true);
    assert.equal((await state.heartbeat()).state.remainingMs, 40 * MINUTE_MS);
  } finally { globalThis.Date = RealDate; }
});
