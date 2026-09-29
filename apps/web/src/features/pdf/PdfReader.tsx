import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FileUp, RotateCw, Scan, TextCursor, ZoomIn, ZoomOut, BookOpen, Maximize2, X } from 'lucide-react';
import { AnnotationMode, getDocument, GlobalWorkerOptions, PasswordResponses, PermissionFlag, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type PageViewport, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DocumentRecord, PdfTarget } from '../../../../../packages/shared/protocol';
import { clamp, displayToPageRect, orderedRect, pageToDisplayRect, pdfPageNumber, unionRects, type Rect } from './geometry';
import { EXTRACTION_VERSION, extractPageText, sourceIdentity, type ExtractedPage, type TextRun } from './text';
import './pdf.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>;
type Loaded = { pdf: PDFDocumentProxy; record: DocumentRecord; canCopy: boolean };
type Rendered = { viewport: PageViewport; extraction: ExtractedPage; pageIndex: number; documentId: string };
export type ReaderAction = {type:'open-sample'|'select-excerpt';nonce:number};
export type PdfReaderProps = {
  action?: ReaderAction;
  onDocument: (document: DocumentRecord | null) => void;
  onTarget: (target: PdfTarget | null) => void;
  onPage: (pageIndex: number) => void;
  navigation?: { pageIndex: number; rect?: Rect; nonce: number };
  readingText?: string;
  clearSelectionRevision?: number;
  onClearSelection?: () => void;
  onError?: (message: string) => void;
};

function errorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'InvalidPDFException') return '无法打开：PDF 已损坏或格式不受支持。请换一个有效 PDF 文件。';
  if (name === 'PasswordException') return 'PDF 密码验证未完成。请重新打开并输入正确密码。';
  if (error instanceof Error && error.message.startsWith('PDF：')) return error.message.slice(4);
  return 'PDF 处理失败。请重试或换一个文件；原文件不会被修改。';
}

function relativeRects(range: Range, container: HTMLElement): Rect[] {
  const bounds = container.getBoundingClientRect();
  return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => [
    clamp(rect.left - bounds.left, 0, bounds.width), clamp(rect.top - bounds.top, 0, bounds.height),
    clamp(rect.right - bounds.left, 0, bounds.width), clamp(rect.bottom - bounds.top, 0, bounds.height),
  ]);
}

function offsetInside(container: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** Exact normalized-text matching only; never estimates a word/audio timestamp. */
function readingRects(container: HTMLElement, page: HTMLElement, text: string): Rect[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const raw = nodes.map(item => item.data).join('');
  let normalized = '';
  const positions: number[] = [];
  for (let index = 0; index < raw.length; index++) if (!/\s/.test(raw[index])) { normalized += raw[index]; positions.push(index); }
  const needle = text.replace(/\s/g, '');
  if (!needle) return [];
  const start = normalized.indexOf(needle);
  if (start < 0) return [];
  const rawStart = positions[start], rawEnd = positions[start + needle.length - 1] + 1;
  const range = document.createRange();
  let total = 0, started = false;
  for (const item of nodes) {
    if (!started && total + item.length > rawStart) { range.setStart(item, rawStart - total); started = true; }
    if (started && total + item.length >= rawEnd) { range.setEnd(item, rawEnd - total); break; }
    total += item.length;
  }
  return relativeRects(range, page);
}

export function PdfReader(props: PdfReaderProps) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLElement | null>(null);
  const loadTask = useRef<PDFDocumentLoadingTask | null>(null);
  const loadTicket = useRef(0);
  const lastTextSelection = useRef('');
  const passwordUpdater = useRef<((password: string) => void) | null>(null);
  const dragOrigin = useRef<[number, number] | null>(null);
  const regionPointer = useRef<{ element: HTMLDivElement; pointerId: number } | null>(null);
  const clearRevision = useRef(props.clearSelectionRevision ?? 0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageEntry, setPageEntry] = useState('1');
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [width, setWidth] = useState(450);
  const [mode, setMode] = useState<'text' | 'region'>('text');
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState('');
  const [password, setPassword] = useState('');
  const [outline, setOutline] = useState<Outline>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [selected, setSelected] = useState<{ documentId: string; pageIndex: number; rects: Rect[] } | null>(null);
  const [highlightRects, setHighlightRects] = useState<Rect[]>([]);

  const cancelRegion = useCallback(() => {
    dragOrigin.current = null;
    const pointer = regionPointer.current;
    regionPointer.current = null;
    if (pointer?.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId);
    setDragRect(null);
  }, []);

  const clearLocalSelection = useCallback(() => {
    cancelRegion();
    window.getSelection()?.removeAllRanges();
    lastTextSelection.current = '';
    setSelected(null);
    setHighlightRects([]);
  }, [cancelRegion]);

  useEffect(() => {
    const revision = props.clearSelectionRevision ?? 0;
    if (clearRevision.current === revision) return;
    clearRevision.current = revision;
    clearLocalSelection();
  }, [props.clearSelectionRevision, clearLocalSelection]);

  function clearSelection() {
    clearLocalSelection();
    if (callbacks.current.onClearSelection) callbacks.current.onClearSelection();
    else callbacks.current.onTarget(null);
  }

  function changeMode(next: 'text' | 'region') {
    if (mode === next) return;
    cancelRegion();
    window.getSelection()?.removeAllRanges();
    lastTextSelection.current = '';
    setMode(next);
  }

  function report(message: string) { setError(message); callbacks.current.onError?.(message); }

  async function openPdf(source: () => Promise<{ blob: Blob; fileName: string }>) {
    const ticket = ++loadTicket.current;
    clearLocalSelection();
    callbacks.current.onDocument(null);
    callbacks.current.onTarget(null);
    setLoaded(null); setRendered(null); setOutline([]); setSelected(null); setError(''); setLoading(true);
    setPasswordPrompt(''); setPassword(''); passwordUpdater.current = null;
    const oldTask = loadTask.current;
    loadTask.current = null;
    if (oldTask) await oldTask.destroy().catch(() => undefined);
    try {
      const { blob, fileName } = await source();
      if (ticket !== loadTicket.current) return;
      if (blob.size > MAX_FILE_BYTES) throw new Error('PDF：当前版本单文件上限为 100 MB，请选择更小的 PDF。');
      if (!blob.size) throw new Error('PDF：所选文件为空，请选择一个有效 PDF。');
      const bytes = await blob.arrayBuffer();
      const header = new TextDecoder().decode(bytes.slice(0, 1024));
      if (!header.includes('%PDF-')) throw new Error('PDF：所选文件不是可识别的 PDF，请检查文件格式。');
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const documentId = `sha256-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (ticket !== loadTicket.current) return;
      // Low-level display API only: no scripting manager, annotations, embedded links, or remote document URL.
      const task = getDocument({ data: bytes, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true, canvasMaxAreaInBytes: 64 * 1024 * 1024 });
      loadTask.current = task;
      task.onPassword = (update: (value: string) => void, reason: number) => {
        if (ticket !== loadTicket.current) return;
        passwordUpdater.current = update;
        setPassword('');
        setPasswordPrompt(reason === PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重试。' : '此 PDF 需要密码。密码只用于本次打开，不会保存。');
      };
      const pdf = await task.promise;
      if (ticket !== loadTicket.current) { await task.destroy(); return; }
      const [pageLabels, permissions] = await Promise.all([pdf.getPageLabels().catch(() => null), pdf.getPermissions()]);
      if (ticket !== loadTicket.current) return;
      const canCopy = !permissions || permissions.has(PermissionFlag.COPY);
      const record: DocumentRecord = { documentId, fileName, pageCount: pdf.numPages, pageLabels, extractionVersion: EXTRACTION_VERSION };
      setPasswordPrompt(''); setPassword(''); passwordUpdater.current = null;
      setPageIndex(0); setPageEntry('1'); setRotation(0); setZoom('fit');
      setLoaded({ pdf, record, canCopy });
      callbacks.current.onDocument(record); callbacks.current.onPage(0);
      void pdf.getOutline().then(items => { if (ticket === loadTicket.current) setOutline(items ?? []); }).catch(() => undefined);
    } catch (failure) {
      if (ticket === loadTicket.current) { setPasswordPrompt(''); passwordUpdater.current = null; report(errorMessage(failure)); }
    } finally { if (ticket === loadTicket.current) setLoading(false); }
  }

  function openFile(file: File) { void openPdf(async () => ({ blob: file, fileName: file.name })); }
  function openSample() {
    void openPdf(async () => {
      const response = await fetch('/sample.pdf');
      if (!response.ok) throw new Error('PDF：示例文档加载失败，请重试或导入自己的 PDF。');
      return { blob: await response.blob(), fileName: '神经网络学习入门 · 自制练习.pdf' };
    });
  }

  function cancelOpen() {
    loadTicket.current++; setLoading(false); setPasswordPrompt(''); setPassword(''); passwordUpdater.current = null;
    const task = loadTask.current; loadTask.current = null;
    void task?.destroy().catch(() => undefined);
  }

  useEffect(() => () => {
    loadTicket.current++; lastTextSelection.current = '';
    void loadTask.current?.destroy().catch(() => undefined);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(100, entries[0].contentRect.width - 32)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    cancelRegion();
    setRendering(true); setRendered(null); setHighlightRects([]);
    canvasRef.current = null; textLayerRef.current = null;
    canvasHost.current?.replaceChildren(); textHost.current?.replaceChildren();
    void (async () => {
      page = await loaded.pdf.getPage(pdfPageNumber(pageIndex));
      if (cancelled) return;
      const angle = (page.rotate + rotation) % 360;
      const base = page.getViewport({ scale: 1, rotation: angle });
      const scale = zoom === 'fit' ? Math.max(0.1, Math.min(3, width / base.width)) : zoom;
      const viewport = page.getViewport({ scale, rotation: angle });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width * pixelRatio)); canvas.height = Math.max(1, Math.ceil(viewport.height * pixelRatio));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label', `PDF 第 ${pdfPageNumber(pageIndex)} 页`);
      const textContainer = document.createElement('div');
      textContainer.className = 'textLayer';
      textContainer.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
      canvasHost.current?.replaceChildren(canvas); textHost.current?.replaceChildren(textContainer);
      if (pageRef.current) { pageRef.current.style.width = `${viewport.width}px`; pageRef.current.style.height = `${viewport.height}px`; }
      canvasRef.current = canvas; textLayerRef.current = textContainer;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PDF：浏览器无法创建画布，请使用最新 Edge 或 Chrome。');
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0], annotationMode: AnnotationMode.DISABLE });
      const [, extractedContent] = await Promise.all([renderTask.promise, loaded.canCopy ? page.getTextContent().catch(() => null) : Promise.resolve(null)]);
      const textContent = extractedContent ?? { items: [], styles: {}, lang: null };
      if (cancelled) return;
      const runs: TextRun[] = [];
      for (const item of textContent.items) if ('str' in item) runs.push(item);
      const extraction = extractPageText(runs);
      if (!extractedContent && loaded.canCopy) extraction.warning = '本页文本提取失败。原页仍可查看和框选，请勿依赖逐字朗读。';
      textLayer = new TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      try { await textLayer.render(); } catch {
        if (cancelled) return;
        textContainer.replaceChildren();
        extraction.warning = '文本选区层未能显示，请尝试重新打开，或框选需要讲解的区域。';
      }
      if (cancelled) return;
      setRendered({ viewport, extraction, pageIndex, documentId: loaded.record.documentId });
      setRendering(false);
    })().catch(failure => { if (!cancelled) { setRendering(false); report(errorMessage(failure)); } });
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); if (page) void renderTask?.promise.catch(() => undefined).then(() => page?.cleanup()); };
  }, [loaded, pageIndex, rotation, zoom, width, cancelRegion]);

  useEffect(() => {
    const nav = props.navigation;
    if (!nav || !loaded) return;
    if (nav.pageIndex < 0 || nav.pageIndex >= loaded.record.pageCount) return;
    setPageIndex(nav.pageIndex); setPageEntry(String(pdfPageNumber(nav.pageIndex))); callbacks.current.onPage(nav.pageIndex);
    if (nav.rect) setSelected({ documentId: loaded.record.documentId, pageIndex: nav.pageIndex, rects: [nav.rect] });
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  }, [props.navigation, loaded]);

  useEffect(() => {
    if (!rendered || !textLayerRef.current || !pageRef.current || !props.readingText) { setHighlightRects([]); return; }
    setHighlightRects(readingRects(textLayerRef.current, pageRef.current, props.readingText));
  }, [props.readingText, rendered]);

  function goToPage(next: number) {
    if (!loaded || !Number.isInteger(next)) return;
    const index = clamp(next, 0, loaded.record.pageCount - 1);
    cancelRegion(); window.getSelection()?.removeAllRanges();
    lastTextSelection.current = ''; setPageIndex(index); setPageEntry(String(pdfPageNumber(index))); setError(''); setDragRect(null);
    callbacks.current.onPage(index);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }

  function selectionTarget(ignoreMode=false) {
    if (!ignoreMode && mode !== 'text' || rendering || !rendered || rendered.pageIndex !== pageIndex || !loaded?.canCopy || rendered.documentId !== loaded.record.documentId || !pageRef.current || !textLayerRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const layer = textLayerRef.current;
    if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return;
    const sourceText = selection.toString().trim();
    if (!sourceText) return;
    if (sourceText.length > 12000) { report('所选文字超过 12,000 字符，请缩小到一个段落。'); return; }
    const rects = relativeRects(range, pageRef.current).map(rect => displayToPageRect(rect, rendered.viewport));
    const rect = unionRects(rects);
    const start = offsetInside(layer, range.startContainer, range.startOffset), end = offsetInside(layer, range.endContainer, range.endOffset);
    const target: PdfTarget = { ...sourceIdentity(loaded.record.documentId, pageIndex, sourceText, `text:${start}:${end}`), documentId: loaded.record.documentId, pageIndex, pageLabel: loaded.record.pageLabels?.[pageIndex] ?? null, rect, sourceText };
    if (lastTextSelection.current === target.sourceId) return;
    lastTextSelection.current = target.sourceId; setSelected({ documentId: loaded.record.documentId, pageIndex, rects }); setError(''); callbacks.current.onTarget(target);
  }

  const selectionHandler = useRef(selectionTarget);
  selectionHandler.current = selectionTarget;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = () => { clearTimeout(timer); timer = setTimeout(() => selectionHandler.current(), 0); };
    // The pointer can finish beyond the page edge; keyboard selections also use the real DOM Range.
    document.addEventListener('pointerup', handle);
    document.addEventListener('keyup', handle);
    return () => { clearTimeout(timer); document.removeEventListener('pointerup', handle); document.removeEventListener('keyup', handle); };
  }, []);

  function selectCurrentPage() {
    if (!loaded?.canCopy || !rendered || rendered.pageIndex !== pageIndex || rendered.documentId !== loaded.record.documentId || !rendered.extraction.hasText) return;
    const sourceText = rendered.extraction.readingText;
    if (sourceText.length > 12000) { report('本页文字超过 12,000 字符，请在页上分段选择。'); return; }
    const rect: Rect = [0, 0, 1, 1];
    const target: PdfTarget = { ...sourceIdentity(loaded.record.documentId, pageIndex, sourceText, 'whole-page'), documentId: loaded.record.documentId, pageIndex, pageLabel: loaded.record.pageLabels?.[pageIndex] ?? null, rect, sourceText };
    lastTextSelection.current = ''; setSelected({ documentId: loaded.record.documentId, pageIndex, rects: [rect] }); callbacks.current.onTarget(target);
  }

  function point(event: PointerEvent<HTMLDivElement>): [number, number] {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [clamp(event.clientX - bounds.left, 0, bounds.width), clamp(event.clientY - bounds.top, 0, bounds.height)];
  }

  function startRegion(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || mode !== 'region' || !loaded?.canCopy || !rendered || rendered.pageIndex !== pageIndex || rendered.documentId !== loaded.record.documentId || rendering) return;
    event.preventDefault(); cancelRegion();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionPointer.current = { element: event.currentTarget, pointerId: event.pointerId };
    const start = point(event); dragOrigin.current = start; setDragRect([...start, ...start]);
    window.getSelection()?.removeAllRanges();
  }

  function moveRegion(event: PointerEvent<HTMLDivElement>) {
    if (!dragOrigin.current || regionPointer.current?.pointerId !== event.pointerId) return;
    setDragRect(orderedRect([...dragOrigin.current, ...point(event)]));
  }

  function finishRegion(event: PointerEvent<HTMLDivElement>) {
    if (regionPointer.current?.pointerId !== event.pointerId) return;
    const start = dragOrigin.current;
    cancelRegion();
    if (!start || !loaded || !rendered || rendered.pageIndex !== pageIndex || rendered.documentId !== loaded.record.documentId || !canvasRef.current) return;
    const rect = orderedRect([...start, ...point(event)]);
    if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) { report('框选范围太小，请拖出一个清晰的公式或图表区域。'); return; }
    const source = canvasRef.current;
    const crop = document.createElement('canvas');
    const ratioX = source.width / rendered.viewport.width, ratioY = source.height / rendered.viewport.height;
    const cropWidth = (rect[2] - rect[0]) * ratioX, cropHeight = (rect[3] - rect[1]) * ratioY;
    const shrink = Math.min(1, 1600 / Math.max(cropWidth, cropHeight));
    crop.width = Math.max(1, Math.round(cropWidth * shrink)); crop.height = Math.max(1, Math.round(cropHeight * shrink));
    const context = crop.getContext('2d');
    if (!context) return;
    context.drawImage(source, rect[0] * ratioX, rect[1] * ratioY, cropWidth, cropHeight, 0, 0, crop.width, crop.height);
    const imageDataUrl = crop.toDataURL('image/png');
    if (imageDataUrl.length > 2_900_000) { report('截图超过当前请求上限，请缩小框选区域。'); return; }
    const normalized = displayToPageRect(rect, rendered.viewport);
    const sourceText = '';
    const target: PdfTarget = { ...sourceIdentity(loaded.record.documentId, pageIndex, sourceText, `region:${normalized.map(n => n.toFixed(5)).join(',')}`), documentId: loaded.record.documentId, pageIndex, pageLabel: loaded.record.pageLabels?.[pageIndex] ?? null, rect: normalized, sourceText, imageDataUrl };
    lastTextSelection.current = ''; setSelected({ documentId: loaded.record.documentId, pageIndex, rects: [normalized] }); setError(''); callbacks.current.onTarget(target);
  }

  async function goToOutline(item: Outline[number]) {
    if (!loaded || !item.dest) return;
    const ticket = loadTicket.current;
    try {
      const dest = typeof item.dest === 'string' ? await loaded.pdf.getDestination(item.dest) : item.dest;
      if (!dest) return;
      const index = typeof dest[0] === 'number' ? dest[0] : await loaded.pdf.getPageIndex(dest[0]);
      if (ticket === loadTicket.current) { goToPage(index); setOutlineOpen(false); }
    } catch { if (ticket === loadTicket.current) report('无法定位这个目录项，请使用 PDF 页序号跳转。'); }
  }

  function outlineItems(items: Outline, depth = 0): ReactNode {
    if (depth > 10) return null;
    return items.slice(0, 300).map((item, index) => <li key={`${depth}-${index}`}>
      <button type="button" disabled={!item.dest} title={!item.dest ? '外链目录不会自动打开' : item.title} onClick={() => void goToOutline(item)}>{item.title || '未命名目录项'}</button>
      {item.items.length > 0 && <ul>{outlineItems(item.items, depth + 1)}</ul>}
    </li>);
  }


  function selectExcerpt(){
    if(rendering||!rendered||!loaded?.canCopy||!textLayerRef.current){report('请等页面显示后再选段；扫描页可以手动框选。');return;}
    const spans=[...textLayerRef.current.querySelectorAll('span')].filter(span=>span.textContent?.trim());
    const candidate=spans.find(span=>(span.textContent?.trim().length??0)>=32)??spans.find(span=>(span.textContent?.trim().length??0)>=10);
    if(!candidate){report('本页没有适合快速试读的文本，请在 PDF 上手动选择并核对。');return;}
    const range=document.createRange();range.selectNodeContents(candidate);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
    setMode('text');selectionTarget(true);candidate.scrollIntoView({block:'nearest'});
  }
  const actionHandler=useRef<(action:ReaderAction)=>void>(()=>{});
  actionHandler.current=action=>{if(action.type==='open-sample')void openSample();else selectExcerpt();};
  useEffect(()=>{if(props.action)actionHandler.current(props.action);},[props.action]);

  const activeRects = rendered && selected?.documentId === rendered.documentId && selected.pageIndex === pageIndex ? selected.rects.map(rect => pageToDisplayRect(rect, rendered.viewport)) : [];
  const overlayStyle = (rect: Rect): CSSProperties => ({ left: rect[0], top: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] });
  const shownScale = rendered ? Math.round(rendered.viewport.scale * 100) : 100;
  return <section className={`pdf-reader ${dragOver ? 'is-dragover' : ''}`} aria-label="PDF 阅读器"
    onDragOver={event => { event.preventDefault(); setDragOver(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
    onDrop={event => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files[0]; if (file) openFile(file); }}>
    <div className="pdf-import-row">
      <div className="pdf-document-title"><span className="pdf-eyebrow">教材 · SOURCE</span><strong title={loaded?.record.fileName}>{loaded?.record.fileName ?? '你的学习，从一页开始'}</strong></div>
      <button className="pdf-open" type="button" onClick={() => fileInput.current?.click()}><FileUp size={15} />打开 PDF</button>
      <input ref={fileInput} className="pdf-file-input" type="file" accept=".pdf,application/pdf" aria-label="选择 PDF 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) openFile(file); }} />
    </div>
    {loaded && <>
      <div className="pdf-toolbar" aria-label="PDF 页面工具">
        <button type="button" title="目录" aria-label="展开 PDF 目录" aria-pressed={outlineOpen} onClick={() => setOutlineOpen(value => !value)}><BookOpen size={16} /></button>
        <span className="pdf-tool-divider" />
        <button type="button" title="上一页" aria-label="上一页" disabled={pageIndex === 0} onClick={() => goToPage(pageIndex - 1)}><ChevronLeft size={17} /></button>
        <form className="pdf-page-form" onSubmit={event => { event.preventDefault(); const n = Number(pageEntry); if (n >= 1 && n <= loaded.record.pageCount && Number.isInteger(n)) goToPage(n - 1); else { setPageEntry(String(pdfPageNumber(pageIndex))); report(`请输入 1 到 ${loaded.record.pageCount} 之间的 PDF 页序号。`); } }}>
          <input type="number" aria-label="PDF 页序号" min={1} max={loaded.record.pageCount} value={pageEntry} onChange={event => setPageEntry(event.target.value)} /><span>/ {loaded.record.pageCount}</span>
        </form>
        <button type="button" title="下一页" aria-label="下一页" disabled={pageIndex + 1 === loaded.record.pageCount} onClick={() => goToPage(pageIndex + 1)}><ChevronRight size={17} /></button>
        <span className="pdf-tool-divider" />
        <button type="button" title="缩小" aria-label="缩小" onClick={() => setZoom(clamp((rendered?.viewport.scale ?? 1) / 1.2, 0.25, 3))}><ZoomOut size={16} /></button>
        <span className="pdf-zoom-value">{shownScale}%</span>
        <button type="button" title="放大" aria-label="放大" onClick={() => setZoom(clamp((rendered?.viewport.scale ?? 1) * 1.2, 0.25, 3))}><ZoomIn size={16} /></button>
        <button type="button" title="适应宽度" aria-label="适应宽度" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}><Maximize2 size={16} /></button>
        <button type="button" title="顺时针旋转 90°" aria-label="旋转页面" onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={16} /></button>
      </div>
      <div className="pdf-selection-toolbar">
        <div className="pdf-mode-buttons"><button type="button" aria-pressed={mode === 'text'} disabled={!loaded.canCopy} onClick={() => changeMode('text')}><TextCursor size={14} />选文字</button><button type="button" aria-pressed={mode === 'region'} disabled={!loaded.canCopy} onClick={() => changeMode('region')}><Scan size={14} />框选区域</button></div>
        <div className="pdf-selection-actions">
          <button type="button" className="pdf-clear-selection" title="取消选中（Esc）" disabled={!selected && !dragRect && !highlightRects.length} onClick={clearSelection}><X size={13} />取消选中</button>
          <button type="button" className="pdf-page-text" disabled={rendering || !rendered?.extraction.hasText || !loaded.canCopy} onClick={selectCurrentPage}>选本页文字</button>
        </div>
      </div>
    </>}
    {error && <div className="pdf-error" role="alert"><span>{error}</span><button type="button" aria-label="关闭 PDF 错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {passwordPrompt && <form className="pdf-password" onSubmit={event => { event.preventDefault(); passwordUpdater.current?.(password); setPassword(''); }}>
      <p>{passwordPrompt}</p><label>文档密码<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} autoFocus /></label><div><button type="submit" disabled={!password}>打开文档</button><button type="button" onClick={cancelOpen}>取消</button></div>
    </form>}
    <div ref={scrollRef} className="pdf-scroll" aria-busy={loading || rendering}>
      {!loaded && !loading && <div className="pdf-empty"><div className="pdf-empty-icon"><BookOpen size={35} strokeWidth={1.2} /></div><h2>把教材放在这里</h2><p>拖入 PDF，或选择本机文件。<br />选一段文字，开始你的第一堂课。</p><button type="button" className="pdf-import-primary" onClick={() => fileInput.current?.click()}><FileUp size={16} />选择 PDF 文件</button><button type="button" className="pdf-sample" onClick={openSample}>先试试自制示例 <span>↗</span></button><small>本地读取 · 不上传整本书 · 最大 100 MB</small></div>}
      {loading && !passwordPrompt && <div className="pdf-loading" role="status">正在本机打开 PDF…<button type="button" onClick={cancelOpen}>取消</button></div>}
      {loaded && <>
        {outlineOpen && <nav className="pdf-outline" aria-label="PDF 目录"><div><strong>文档目录</strong><button type="button" onClick={() => setOutlineOpen(false)} aria-label="关闭目录"><X size={15} /></button></div>{outline.length ? <ul>{outlineItems(outline)}</ul> : <p>这份 PDF 没有内置目录，请使用页序号跳转。</p>}</nav>}
        <div className="pdf-page-center">
          <div ref={pageRef} className={`pdf-page ${mode === 'region' ? 'region-mode' : ''}`} data-page-index={pageIndex}
            onPointerDown={startRegion} onPointerMove={moveRegion} onPointerUp={event => { if (mode === 'region') finishRegion(event); }}
            onPointerCancel={cancelRegion} onLostPointerCapture={cancelRegion}>
            <div ref={canvasHost} className="pdf-canvas-host" />
            <div ref={textHost} className="pdf-text-host" />
            <div className="pdf-highlight-layer" aria-hidden="true">{activeRects.map((rect, index) => <span className="pdf-selected-highlight" key={`s-${index}`} style={overlayStyle(rect)} />)}{highlightRects.map((rect, index) => <span className="pdf-reading-highlight" key={`r-${index}`} style={overlayStyle(rect)} />)}{dragRect && <span className="pdf-drag-highlight" style={overlayStyle(dragRect)} />}</div>
            {rendering && <div className="pdf-rendering" role="status">正在渲染这一页…</div>}
          </div>
        </div>
      </>}
    </div>
    {loaded && <div className="pdf-footer"><span>PDF 第 {pdfPageNumber(pageIndex)} 页{loaded.record.pageLabels?.[pageIndex] ? ` · 书面页码 ${loaded.record.pageLabels[pageIndex]}` : ' · 书面页码未标注'}</span><span>{mode === 'region' ? '拖动框选公式或图表' : '拖动选择原文'}</span></div>}
    {loaded && !loaded.canCopy && <p className="pdf-quality-warning">文档权限禁止复制，本应用仅显示页面，已禁用文字提取和区域截图。</p>}
    {loaded?.canCopy && rendered?.extraction.warning && <p className="pdf-quality-warning">{rendered.extraction.warning}</p>}
    {loaded?.canCopy && rendered?.extraction.hasText && !rendered.extraction.warning && <p className="pdf-extraction-note">文本按 PDF 文本层提取；多栏、上下标和公式请与原页核对。</p>}
  </section>;
}
