import { getConfig } from './config.js';
import { siteForHost } from './usage.js';
import { clock, minutesText, siteLabel, usageRequest } from './ui.js';

const byId = (id) => document.getElementById(id);
const site = byId('site');
let busy = false;

function showStudyForm(show) {
  byId('study-form').hidden = !show;
  byId('study-open').setAttribute('aria-expanded', String(show));
}

function render(state) {
  const studying = Boolean(state.study);
  const schedule = state.reason === 'schedule';
  byId('mode').textContent = schedule ? '定时屏蔽中'
    : studying ? (state.reason === 'study' ? '学习时间已到' : '学习 · 已用 / 计划')
      : '娱乐剩余';
  byId('time').textContent = schedule ? ''
    : studying ? `${clock(state.study.usedMs)} / ${minutesText(state.study.plannedMs)}`
      : clock(state.remainingMs, Math.ceil);
  byId('detail').textContent = schedule ? '定时屏蔽结束后才能开启学习或续时。'
    : `今天已娱乐 ${minutesText(state.usedMs)} · 基础额度 ${state.limitMinutes} 分钟`;
  byId('study-open').hidden = schedule;
  if (schedule) showStudyForm(false);
  byId('study-open').textContent = studying ? '延长学习' : '开启学习';
  byId('study-add').textContent = studying ? '增加时长' : '开始学习';
  byId('study-finish').hidden = !studying || schedule;
}

async function refresh() {
  const domain = site.value;
  if (busy || !domain) return;
  try {
    const state = await usageRequest('status', { domain });
    if (!busy && domain === site.value) render(state);
  } catch (error) {
    byId('message').textContent = error.message;
  }
}

async function act(action, minutes) {
  if (busy || !site.value) return;
  busy = true;
  const buttons = [byId('study-open'), byId('study-add'), byId('study-finish')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await usageRequest('action', { domain: site.value, action, minutes });
    showStudyForm(false);
    byId('message').textContent = '';
  } catch (error) {
    byId('message').textContent = error.message;
  } finally {
    busy = false;
    buttons.forEach((button) => { button.disabled = false; });
    await refresh();
  }
}

byId('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
byId('study-open').addEventListener('click', () => {
  const show = byId('study-form').hidden;
  showStudyForm(show);
  if (show) {
    byId('minutes').focus();
    byId('minutes').select();
  }
});
byId('study-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act('study-add', byId('minutes').valueAsNumber);
});
byId('study-finish').addEventListener('click', () => act('study-finish'));
site.addEventListener('change', () => {
  showStudyForm(false);
  refresh();
});

async function initialize() {
  const config = await getConfig();
  for (const domain of Object.keys(config.leisureLimits)) {
    site.add(new Option(siteLabel(domain), domain));
  }
  if (!site.options.length) {
    byId('empty').hidden = false;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.url) {
    const blocked = tab.url.startsWith(chrome.runtime.getURL('blocked.html'));
    const url = blocked ? new URL(tab.url).hash.slice(1) : tab.url;
    const host = URL.canParse(url) ? new URL(url).hostname : '';
    const domain = siteForHost(config, host);
    if (domain) site.value = domain;
  }
  byId('usage').hidden = false;
  await refresh();
  setInterval(refresh, 1000);
}

initialize().catch((error) => { byId('message').textContent = error.message; });
