(() => {
  if (globalThis.morningProtectionOverlay) return;
  globalThis.morningProtectionOverlay = true;
  const id = 'morning-protection-usage';
  const positionKey = 'overlayPosition';
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;
      pointer-events: none; color: #fff; font: 13px/1.4 system-ui, sans-serif; }
    .panel { padding: 8px 12px; border: 1px solid #ffffff30; border-radius: 10px;
      background: #292522bd; backdrop-filter: blur(8px); box-shadow: 0 2px 12px #0002;
      font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: auto;
      cursor: grab; touch-action: none; user-select: none; }
    .panel.dragging { cursor: grabbing; }
    .label { color: #fff; opacity: .84; margin-right: 8px; }
    strong { font-size: 15px; }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.title = '拖动调整位置';
  const label = document.createElement('span');
  label.className = 'label';
  const time = document.createElement('strong');
  panel.append(label, time);
  shadow.append(panel);
  let busy = false;
  let position = { x: 18, y: 84 };
  let drag;

  function place(target = position) {
    if (!host.isConnected) return target;
    const { width, height } = host.getBoundingClientRect();
    const viewport = document.documentElement;
    const x = Math.min(Math.max(0, target.x), Math.max(0, viewport.clientWidth - width));
    const y = Math.min(Math.max(0, target.y), Math.max(0, viewport.clientHeight - height));
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    return { x, y };
  }

  panel.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    event.preventDefault();
    event.stopPropagation();
    const { left, top } = host.getBoundingClientRect();
    drag = { id: event.pointerId, offsetX: event.clientX - left, offsetY: event.clientY - top, left, top };
    panel.setPointerCapture(event.pointerId);
    panel.classList.add('dragging');
  });

  panel.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    event.stopPropagation();
    position = place({ x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY });
  });

  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    event.stopPropagation();
    const moved = position.x !== drag.left || position.y !== drag.top;
    drag = undefined;
    panel.classList.remove('dragging');
    if (moved) {
      chrome.storage.local.set({ [positionKey]: position }).catch((error) => {
        console.warn('Morning Protection: could not save timer position', error);
      });
    }
  }

  panel.addEventListener('pointerup', finishDrag);
  panel.addEventListener('pointercancel', finishDrag);
  panel.addEventListener('lostpointercapture', finishDrag);
  panel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  window.addEventListener('resize', () => place());

  function clock(ms, round) {
    const seconds = round(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  async function render() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const { state } = await chrome.runtime.sendMessage({ type: 'usage-heartbeat' });
      if (!state?.domain || state.reason) {
        host.remove();
        return;
      }
      if (state.study) {
        label.textContent = '学习 · 已用 / 计划';
        time.textContent = `${clock(state.study.usedMs, Math.floor)} / ${state.study.plannedMs / 60000} 分钟`;
      } else {
        label.textContent = '娱乐剩余';
        time.textContent = clock(state.remainingMs, Math.ceil);
      }
      if (!host.isConnected) document.documentElement.append(host);
      place();
    } catch {
      host.remove();
      if (!chrome.runtime?.id) clearInterval(timer);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(render, 1000);
  document.addEventListener('visibilitychange', render);
  chrome.storage.local.get(positionKey).then((stored) => {
    const saved = stored[positionKey];
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y) && !host.isConnected) position = saved;
  }).catch((error) => {
    console.warn('Morning Protection: could not read timer position', error);
  }).finally(render);
})();
