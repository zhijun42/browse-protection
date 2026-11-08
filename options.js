import {
  DEFAULTS, getConfig, normalizeDomains, normalizeLeisureLimits, isBlockedNow, nextUnlockAt, toMinutes,
} from './config.js';

const fields = {
  blockStart: document.getElementById('blockStart'),
  blockEnd: document.getElementById('blockEnd'),
  domains: document.getElementById('domains'),
  leisureLimits: document.getElementById('leisureLimits'),
  enabled: document.getElementById('enabled'),
};
const statusEl = document.getElementById('status');
const savedEl = document.getElementById('saved');

function renderStatus(config) {
  if (!config.enabled) {
    statusEl.innerHTML = '定时屏蔽已<b>关闭</b>。';
    return;
  }
  if (isBlockedNow(config)) {
    const unlockAt = nextUnlockAt(config);
    const hours = Math.floor((unlockAt - new Date()) / 3600000);
    const minutes = Math.ceil(((unlockAt - new Date()) % 3600000) / 60000);
    statusEl.innerHTML = `现在<b>屏蔽中</b>，约 ${hours} 小时 ${minutes} 分钟后解锁。`;
  } else {
    statusEl.innerHTML = `定时屏蔽将在 ${config.blockStart} 开始。`;
  }
}

async function load() {
  const config = await getConfig();
  fields.blockStart.value = config.blockStart;
  fields.blockEnd.value = config.blockEnd;
  fields.domains.value = config.domains.join('\n');
  fields.leisureLimits.value = Object.entries(config.leisureLimits)
    .map(([domain, minutes]) => `${domain} ${minutes}`).join('\n');
  fields.enabled.checked = config.enabled;
  renderStatus(config);
}

function parseLimits(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const pairs = lines.map((line) => {
    const [domain, minutes, extra] = line.split(/\s+/);
    if (extra || !/^\d+$/.test(minutes ?? '')) throw new Error('请使用「域名 分钟」格式。');
    return [domain, Number(minutes)];
  });
  const limits = normalizeLeisureLimits(Object.fromEntries(pairs));
  if (Object.keys(limits).length !== lines.length) {
    throw new Error('请检查域名、重复网站及分钟数（1 至 1440）。');
  }
  return limits;
}

document.getElementById('save').addEventListener('click', async () => {
  try {
    const next = {
      blockStart: toMinutes(fields.blockStart.value) === null ? DEFAULTS.blockStart : fields.blockStart.value,
      blockEnd: toMinutes(fields.blockEnd.value) === null ? DEFAULTS.blockEnd : fields.blockEnd.value,
      domains: normalizeDomains(fields.domains.value),
      leisureLimits: parseLimits(fields.leisureLimits.value),
      enabled: fields.enabled.checked,
    };
    await chrome.storage.sync.set(next);
    await load();
    savedEl.textContent = '已保存';
  } catch (error) {
    savedEl.textContent = error.message;
  }
});

load();
