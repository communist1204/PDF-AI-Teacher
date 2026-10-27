const image = document.getElementById('screen');
const selection = document.getElementById('selection');
const hint = document.getElementById('hint');
let start = null, pending = false, frameId = 0, ready = false;
const point = event => ({ x: Math.max(0, Math.min(window.innerWidth, event.clientX)), y: Math.max(0, Math.min(window.innerHeight, event.clientY)) });
const rect = end => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
const cancel = () => { if (frameId) void window.screenCrop.cancel(frameId); };
window.screenCrop.onFrame(async value => {
  ready = false; start = null; pending = false; frameId = value?.frameId ?? 0;
  document.body.dataset.frameId = String(frameId);
  document.body.dataset.ready = 'false';
  selection.style.display = 'none'; document.getElementById('shade').style.display = 'block';
  hint.textContent = '拖动框选文字，松开后识别并朗读 · Esc / 右键取消';
  if (!value) { image.removeAttribute('src'); return; }
  const own = value.frameId;
  image.src = value.imageDataUrl;
  try {
    await image.decode();
    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    if (frameId !== own) return;
    ready = true; document.body.dataset.ready = 'true';
    await window.screenCrop.ready(own);
  } catch { if (frameId === own) cancel(); }
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pending || !ready) return;
  start = point(event); document.body.setPointerCapture(event.pointerId);
  document.getElementById('shade').style.display = 'none';
});
document.addEventListener('pointermove', event => {
  if (!start || pending) return; const r = rect(point(event));
  Object.assign(selection.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
});
document.addEventListener('pointerup', async event => {
  if (!start || event.button !== 0 || pending) return;
  const r = rect(point(event)); start = null;
  if (document.body.hasPointerCapture(event.pointerId)) document.body.releasePointerCapture(event.pointerId);
  if (r.width < 6 || r.height < 6) { hint.textContent = '选区太小，请重新拖动框选文字 · Esc 取消'; return; }
  pending = true; const own = frameId;
  try { await window.screenCrop.select(own, { x: r.x / window.innerWidth, y: r.y / window.innerHeight, width: r.width / window.innerWidth, height: r.height / window.innerHeight }); }
  catch { if (own === frameId) { pending = false; hint.textContent = '选区无效，请重新框选 · Esc 取消'; } }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
document.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); });
