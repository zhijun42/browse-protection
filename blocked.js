import { getConfig, getOriginalUrl, hostMatches, isBlockedNow, nextUnlockAt } from './config.js';
import { minutesText, siteLabel, usageRequest } from './ui.js';

const byId = (id) => document.getElementById(id);
let acting = false;
let reading = false;
let showingSchedule = false;
let statusError = false;

function setText(id, value) {
  byId(id).textContent = value;
}

function showError(message = '', fromStatus = false) {
  statusError = Boolean(message && fromStatus);
  setText('message', message);
  byId('message').hidden = !message;
}

function clearStatusError() {
  if (statusError) showError();
}

function showActions(reason) {
  byId('leisure-actions').hidden = reason !== 'leisure';
  byId('study-actions').hidden = reason !== 'study';
  byId('options').hidden = reason !== 'schedule';
}

function renderSchedule(config, now) {
  const seconds = Math.max(0, Math.ceil((nextUnlockAt(config, now) - now) / 1000));
  const countdown = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
  showActions('schedule');
  setText('title', '这段时间留给自己');
  setText('subtitle', '定时屏蔽中，结束后会检查是否可以返回。');
  setText('countdown', countdown);
  setText('unlock-hint', `距离定时解锁（${config.blockEnd}）`);
  setText('window', `屏蔽时段 ${config.blockStart} – ${config.blockEnd} · ${config.domains.join('、')}`);
  clearStatusError();
}

async function render() {
  if (acting || document.visibilityState === 'hidden') return;
  let config;
  try {
    config = await getConfig();
  } catch (error) {
    showError(error.message, true);
    return;
  }
  if (acting) return;

  const now = new Date();
  const originalUrl = getOriginalUrl(new URL(location.href));
  const host = originalUrl ? new URL(originalUrl).hostname : null;
  // Scheduled unlock time comes from settings; it must work even if the usage worker is unavailable.
  if (isBlockedNow(config, now) && (!host || hostMatches(host, config.domains))) {
    showingSchedule = true;
    renderSchedule(config, now);
    return;
  }
  if (showingSchedule) {
    showingSchedule = false;
    showActions(null);
    setText('title', '定时屏蔽已结束');
    setText('subtitle', '正在检查是否可以返回…');
    setText('countdown', '');
    setText('unlock-hint', '');
    setText('window', '');
  }
  if (reading) return;
  reading = true;
  try {
    const state = await usageRequest('status');
    if (acting || showingSchedule || state.reason === 'schedule') return;
    const { reason } = state;
    showActions(reason);
    clearStatusError();
    setText('window', '');
    const site = siteLabel(state.domain);
    if (reason === 'study') {
      setText('title', '学习时间已到');
      setText('subtitle', `你已完成这次在${site}的学习计划。接下来想怎么做？`);
      setText('countdown', minutesText(state.study.usedMs));
      setText('unlock-hint', `计划 ${minutesText(state.study.plannedMs)} · 等待选择时不计时`);
    } else if (reason === 'leisure') {
      setText('title', '停一下，做个选择');
      setText('subtitle', `今天已在${site}冲浪`);
      setText('countdown', minutesText(state.usedMs));
      setText('unlock-hint', '这一轮的娱乐时间已用完。');
    } else {
      setText('title', '已经解锁了');
      setText('subtitle', '正在返回原来的页面…');
      setText('countdown', '');
      setText('unlock-hint', '');
    }
  } catch (error) {
    if (!showingSchedule) showError(error.message, true);
  } finally {
    reading = false;
  }
}

async function act(action, minutes) {
  if (acting) return;
  acting = true;
  const buttons = [...document.querySelectorAll('.actions button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await usageRequest('action', { action, minutes });
    showError();
  } catch (error) {
    showError(error.message);
  } finally {
    acting = false;
    buttons.forEach((button) => { button.disabled = false; });
    await render();
  }
}

byId('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
byId('leave').addEventListener('click', () => act('leave'));
byId('study-finish').addEventListener('click', () => act('study-finish'));
byId('study-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act('study-add', byId('minutes').valueAsNumber);
});
document.querySelectorAll('[data-extra]').forEach((button) => {
  button.addEventListener('click', () => act('leisure-add', Number(button.dataset.extra)));
});
document.addEventListener('visibilitychange', render);
window.addEventListener('hashchange', render);
render();
setInterval(render, 1000);
