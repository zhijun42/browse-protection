export function clock(ms, round = Math.floor) {
  const seconds = Math.max(0, round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function minutesText(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function siteLabel(domain) {
  return { 'xiaohongshu.com': '小红书', 'youtube.com': 'YouTube' }[domain] ?? domain;
}

export async function usageRequest(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type: `usage-${type}`, ...data });
  if (!response?.ok) throw new Error(response?.error || '暂时无法更新，请重试。');
  return response.state;
}
