const image = document.getElementById('screen');
const selection = document.getElementById('selection');
const hint = document.getElementById('hint');
let start = null, pending = false;
const point = event => ({ x: Math.max(0, Math.min(window.innerWidth, event.clientX)), y: Math.max(0, Math.min(window.innerHeight, event.clientY)) });
const rect = end => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
window.screenCrop.image().then(value => { image.src = value; }).catch(() => window.screenCrop.cancel());
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pending) return;
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
  if (r.width < 6 || r.height < 6) { hint.textContent = '选区太小，请重新拖动框选文字 · Esc 取消'; return; }
  pending = true;
  try { await window.screenCrop.select({ x: r.x / window.innerWidth, y: r.y / window.innerHeight, width: r.width / window.innerWidth, height: r.height / window.innerHeight }); }
  catch { pending = false; hint.textContent = '选区无效，请重新框选 · Esc 取消'; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.screenCrop.cancel(); });
document.addEventListener('contextmenu', event => { event.preventDefault(); void window.screenCrop.cancel(); });
