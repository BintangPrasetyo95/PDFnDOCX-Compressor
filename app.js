/**
 * ShrinkIt – Smart PDF & DOCX Compressor
 * app.js – Core Compression Engine (v2 – Deep Compression)
 *
 * PDF  → PDF.js renders each page to canvas at decreasing scale + JPEG quality,
 *         rebuilt with pdf-lib. Iterates until target size met or absolute min hit.
 * DOCX → JSZip unpacks, Canvas re-encodes every image at decreasing JPEG quality,
 *         re-packed with maximum DEFLATE. Iterates until target size met.
 *
 * Key fix: minScale → 0.10, minQuality → 0.01  (pushes much harder)
 *          Best-result tracking so final download is always the smallest achieved.
 */

// ── Global State ──────────────────────────────────────────────────────────────
const state = {
  file: null,
  fileBytes: null,
  resultBlob: null,
  targetBytes: 0,
  iterations: 0,
  originalSize: 0,
};

// ── DOM References ────────────────────────────────────────────────────────────
const dropzone        = document.getElementById('dropzone');
const fileInput       = document.getElementById('fileInput');
const fileInfoBar     = document.getElementById('fileInfoBar');
const fileIconWrap    = document.getElementById('fileIconWrap');
const fileTypeLabel   = document.getElementById('fileTypeLabel');
const fileName        = document.getElementById('fileName');
const fileSizeOrig    = document.getElementById('fileSizeOrig');
const btnRemove       = document.getElementById('btnRemove');

const settingsPanel   = document.getElementById('settingsPanel');
const targetSizeInput = document.getElementById('targetSize');
const targetUnitSel   = document.getElementById('targetUnit');
const btnCompress     = document.getElementById('btnCompress');

const progressPanel   = document.getElementById('progressPanel');
const progressLabel   = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const progressFill    = document.getElementById('progressFill');
const iterationLog    = document.getElementById('iterationLog');
const metricOriginal  = document.getElementById('metricOriginal');
const metricCurrent   = document.getElementById('metricCurrent');
const metricTarget    = document.getElementById('metricTarget');

const resultPanel     = document.getElementById('resultPanel');
const resultIcon      = document.getElementById('resultIcon');
const resultTitle     = document.getElementById('resultTitle');
const resultDesc      = document.getElementById('resultDesc');
const statFinalSize   = document.getElementById('statFinalSize');
const statReduction   = document.getElementById('statReduction');
const statIterations  = document.getElementById('statIterations');
const btnDownload     = document.getElementById('btnDownload');
const btnReset        = document.getElementById('btnReset');

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024)        return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }
function sleep(ms)             { return new Promise(r => setTimeout(r, ms)); }

function addLogEntry(iter, text, size, status = 'pass') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${status}`;

  const iterEl = document.createElement('span');
  iterEl.className = 'log-iter';
  iterEl.textContent = iter > 0 ? `#${iter}` : '→';

  const textEl = document.createElement('span');
  textEl.className = 'log-text';
  textEl.textContent = text;

  const sizeEl = document.createElement('span');
  sizeEl.className = 'log-size';
  sizeEl.textContent = formatBytes(size);

  entry.append(iterEl, textEl, sizeEl);
  iterationLog.appendChild(entry);
  iterationLog.scrollTop = iterationLog.scrollHeight;
}

function setProgress(pct, label) {
  progressFill.style.width = clamp(pct, 0, 100) + '%';
  progressPercent.textContent = Math.round(pct) + '%';
  if (label) progressLabel.textContent = label;
}

function updateMetrics(current) {
  metricCurrent.textContent = formatBytes(current);
}

// ── File Handling ─────────────────────────────────────────────────────────────
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
btnRemove.addEventListener('click', resetAll);

function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx'].includes(ext)) {
    alert('Please select a PDF or DOCX file.');
    return;
  }
  state.file = file;
  state.originalSize = file.size;

  fileName.textContent    = file.name;
  fileSizeOrig.textContent = formatBytes(file.size);

  if (ext === 'pdf') {
    fileTypeLabel.textContent    = 'PDF';
    fileIconWrap.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    fileIconWrap.classList.remove('docx');
  } else {
    fileTypeLabel.textContent    = 'DOCX';
    fileIconWrap.style.background = 'linear-gradient(135deg, #2563eb, #06b6d4)';
    fileIconWrap.classList.add('docx');
  }

  dropzone.classList.add('hidden');
  fileInfoBar.classList.remove('hidden');
  settingsPanel.classList.remove('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
}

btnCompress.addEventListener('click', startCompression);

// ── Main Compression Entry ────────────────────────────────────────────────────
async function startCompression() {
  const targetVal = parseFloat(targetSizeInput.value);
  if (isNaN(targetVal) || targetVal <= 0) {
    alert('Please enter a valid target size greater than 0.');
    return;
  }

  const unit        = targetUnitSel.value;
  state.targetBytes = unit === 'MB' ? targetVal * 1024 * 1024 : targetVal * 1024;
  state.iterations  = 0;

  settingsPanel.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  iterationLog.innerHTML = '';

  metricOriginal.textContent = formatBytes(state.originalSize);
  metricCurrent.textContent  = formatBytes(state.originalSize);
  metricTarget.textContent   = formatBytes(state.targetBytes);
  setProgress(0, 'Reading file...');

  const reader = new FileReader();
  reader.onload = async (e) => {
    state.fileBytes = new Uint8Array(e.target.result);

    if (state.originalSize <= state.targetBytes) {
      addLogEntry(0, 'File already at or below target size', state.originalSize, 'success');
      state.resultBlob = new Blob([state.fileBytes], { type: state.file.type });
      showResult(state.originalSize, 0, 0);
      return;
    }

    const ext = state.file.name.split('.').pop().toLowerCase();
    try {
      let resultBlob;
      if (ext === 'pdf') {
        resultBlob = await compressPDF(state.fileBytes, state.targetBytes);
      } else {
        resultBlob = await compressDOCX(state.fileBytes, state.targetBytes);
      }
      state.resultBlob = resultBlob;
      showResult(
        resultBlob.size,
        state.iterations,
        ((state.originalSize - resultBlob.size) / state.originalSize * 100)
      );
    } catch (err) {
      console.error(err);
      progressLabel.textContent = '❌ Error: ' + err.message;
    }
  };
  reader.readAsArrayBuffer(state.file);
}

// ── PDF Compression ───────────────────────────────────────────────────────────
/**
 * Renders each page to a canvas at decreasing scale + JPEG quality.
 * Tracks the smallest result found and always returns it.
 *
 * Scale range : 1.5 → 0.10   (much lower floor = drastically smaller)
 * Quality range: 0.85 → 0.01  (much lower floor = drastically smaller)
 */
async function compressPDF(inputBytes, targetBytes) {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const mode      = document.querySelector('input[name="mode"]:checked').value;
  let scale       = mode === 'aggressive' ? 1.2 : 1.5;
  let quality     = mode === 'aggressive' ? 0.70 : 0.85;

  // ▼ These are now MUCH lower — the engine will push all the way down
  const minScale    = 0.10;
  const minQuality  = 0.01;
  // Hard cap on canvas pixel width at minimum scale (prevents huge canvases on large PDFs)
  const maxPxWidth  = 1800; // at first pass; shrinks proportionally with scale
  const maxIter     = 30;

  let iteration    = 0;
  let bestBytes    = null; // track smallest result so far
  let bestPdfBytes = null;

  addLogEntry(0, 'Original PDF loaded', inputBytes.byteLength, 'info');
  setProgress(5, 'Loading PDF document...');

  const loadingTask = pdfjsLib.getDocument({ data: inputBytes.slice() });
  const pdfDoc      = await loadingTask.promise;
  const totalPages  = pdfDoc.numPages;

  addLogEntry(0, `PDF has ${totalPages} page(s)`, inputBytes.byteLength, 'info');

  while (iteration < maxIter) {
    iteration++;
    state.iterations = iteration;

    const pct = 5 + (iteration / maxIter) * 85;
    setProgress(pct, `Pass #${iteration} — scale: ${scale.toFixed(2)}, Q${Math.round(quality * 100)}%`);

    // Render all pages at current scale/quality
    const pageImageBytes = [];
    const pageDimensions = [];

    // Cap pixel width so high-res PDFs don't blow up at large scales
    const pixelCap = Math.max(200, maxPxWidth * (scale / (mode === 'aggressive' ? 1.2 : 1.5)));

    for (let p = 1; p <= totalPages; p++) {
      const page     = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale });
      // Apply pixel cap: if viewport is wider than cap, shrink both dims proportionally
      const capScale = viewport.width > pixelCap ? pixelCap / viewport.width : 1;
      const canvas   = document.createElement('canvas');
      canvas.width   = Math.max(1, Math.round(viewport.width  * capScale));
      canvas.height  = Math.max(1, Math.round(viewport.height * capScale));
      const ctx      = canvas.getContext('2d');
      // Use a scaled viewport that matches the capped canvas dimensions
      const renderViewport = page.getViewport({ scale: scale * capScale });

      // White fill so JPEG doesn't get alpha artifacts
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const dataURL  = canvas.toDataURL('image/jpeg', quality);
      const b64      = dataURL.split(',')[1];
      const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

      pageImageBytes.push(imgBytes);
      pageDimensions.push({ width: canvas.width, height: canvas.height });
    }

    // Build PDF with pdf-lib
    const { PDFDocument } = PDFLib;
    const newPdf = await PDFDocument.create();

    for (let i = 0; i < pageImageBytes.length; i++) {
      const jpgImage = await newPdf.embedJpg(pageImageBytes[i]);
      const { width, height } = pageDimensions[i];
      const pg = newPdf.addPage([width, height]);
      pg.drawImage(jpgImage, { x: 0, y: 0, width, height });
    }

    const pdfBytes  = await newPdf.save({ useObjectStreams: true });
    const byteCount = pdfBytes.byteLength;

    // ── Track the best (smallest) result ──
    if (bestBytes === null || byteCount < bestBytes) {
      bestBytes    = byteCount;
      bestPdfBytes = pdfBytes;
    }

    const status = byteCount <= targetBytes ? 'success' : 'pass';
    addLogEntry(
      iteration,
      `Scale ${scale.toFixed(2)} · Q${Math.round(quality * 100)}%`,
      byteCount,
      status
    );
    updateMetrics(byteCount);

    // ── Target met → return immediately ──
    if (byteCount <= targetBytes) {
      setProgress(100, '✓ Target reached!');
      return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    // ── Decide how aggressively to reduce for next pass ──
    const ratio = byteCount / targetBytes;

    if (ratio > 5)        { scale = Math.max(minScale, scale - 0.50); quality = Math.max(minQuality, quality - 0.25); }
    else if (ratio > 3)   { scale = Math.max(minScale, scale - 0.35); quality = Math.max(minQuality, quality - 0.18); }
    else if (ratio > 2)   { scale = Math.max(minScale, scale - 0.20); quality = Math.max(minQuality, quality - 0.12); }
    else if (ratio > 1.5) { scale = Math.max(minScale, scale - 0.10); quality = Math.max(minQuality, quality - 0.08); }
    else if (ratio > 1.2) { quality = Math.max(minQuality, quality - 0.05); }
    else                  { quality = Math.max(minQuality, quality - 0.03); }

    // ── If already at the floor on both axes → nothing more to do ──
    if (scale <= minScale && quality <= minQuality) {
      addLogEntry(iteration, '⚠ Absolute minimum reached — returning best result', bestBytes, 'fail');
      setProgress(100, 'Minimum compression limit reached.');
      return new Blob([bestPdfBytes], { type: 'application/pdf' });
    }

    await sleep(10);
  }

  // Max iterations hit — return smallest result found
  setProgress(100, 'Max passes done — returning best result.');
  addLogEntry(iteration, 'Max iterations — returning best result', bestBytes, 'fail');
  return new Blob([bestPdfBytes || inputBytes], { type: 'application/pdf' });
}

// ── DOCX Compression ──────────────────────────────────────────────────────────
/**
 * Unzips DOCX, re-compresses every embedded image at decreasing JPEG quality,
 * re-zips with DEFLATE level 9. Tracks best result and always returns it.
 *
 * Quality range: 0.82 → 0.01
 */
async function compressDOCX(inputBytes, targetBytes) {
  const mode       = document.querySelector('input[name="mode"]:checked').value;
  let quality      = mode === 'aggressive' ? 0.65 : 0.82;
  // imgScale: shrinks pixel dimensions of images (1.0 = full size, 0.1 = 10% size)
  let imgScale     = 1.0;

  // ▼ Much lower floors — push all the way down
  const minQuality  = 0.01;
  const minImgScale = 0.05; // 5% of original pixels — brutally small but it works
  const maxIter     = 30;

  let iteration    = 0;
  let bestBytes    = null;
  let bestBuffer   = null;

  addLogEntry(0, 'Unzipping DOCX archive...', inputBytes.byteLength, 'info');
  setProgress(8, 'Reading DOCX structure...');

  const zip = await JSZip.loadAsync(inputBytes);

  // Gather image file keys from all Office media folders
  const imgKeys = Object.keys(zip.files).filter(name => {
    const lower = name.toLowerCase();
    return (
      lower.includes('/media/') ||
      lower.startsWith('word/media/') ||
      lower.startsWith('ppt/media/') ||
      lower.startsWith('xl/media/')
    ) && !zip.files[name].dir;
  });

  addLogEntry(0, `Found ${imgKeys.length} embedded image(s)`, inputBytes.byteLength, 'info');

  // Pre-read all original image ArrayBuffers once
  const origImgData = {};
  for (const key of imgKeys) {
    origImgData[key] = await zip.file(key).async('arraybuffer');
  }

  while (iteration < maxIter) {
    iteration++;
    state.iterations = iteration;

    const pct = 8 + (iteration / maxIter) * 82;
    setProgress(pct, `Pass #${iteration} — image quality: ${Math.round(quality * 100)}%`);

    // Fresh copy of the zip for this pass
    const freshZip = await JSZip.loadAsync(inputBytes);

    // Re-compress each image at current quality
    for (const key of imgKeys) {
      const lower = key.toLowerCase();
      const data  = origImgData[key];

      // Skip tiny decorative images (< 2 KB)
      if (data.byteLength < 2048) continue;

      const isPng       = lower.endsWith('.png');
      // Pass both quality AND imgScale — this is what makes truly small files possible
      const recompressed = await recompressImage(data, quality, isPng, imgScale);
      if (recompressed) {
        freshZip.file(key, recompressed, {
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        });
      }
    }

    // Generate the new ZIP
    const resultBuffer = await freshZip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    const byteCount = resultBuffer.byteLength;

    // ── Track best ──
    if (bestBytes === null || byteCount < bestBytes) {
      bestBytes  = byteCount;
      bestBuffer = resultBuffer;
    }

    const status = byteCount <= targetBytes ? 'success' : 'pass';
    addLogEntry(iteration, `Q${Math.round(quality * 100)}% · img ${Math.round(imgScale * 100)}%px`, byteCount, status);
    updateMetrics(byteCount);

    if (byteCount <= targetBytes) {
      setProgress(100, '✓ Target reached!');
      return new Blob([resultBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    // ── Reduce quality AND pixel dimensions for next pass ──
    const ratio = byteCount / targetBytes;
    if (ratio > 5) {
      quality  = Math.max(minQuality,  quality  - 0.30);
      imgScale = Math.max(minImgScale, imgScale - 0.30);
    } else if (ratio > 3) {
      quality  = Math.max(minQuality,  quality  - 0.20);
      imgScale = Math.max(minImgScale, imgScale - 0.20);
    } else if (ratio > 2) {
      quality  = Math.max(minQuality,  quality  - 0.12);
      imgScale = Math.max(minImgScale, imgScale - 0.12);
    } else if (ratio > 1.5) {
      quality  = Math.max(minQuality,  quality  - 0.08);
      imgScale = Math.max(minImgScale, imgScale - 0.08);
    } else if (ratio > 1.2) {
      quality  = Math.max(minQuality,  quality  - 0.05);
      imgScale = Math.max(minImgScale, imgScale - 0.04);
    } else {
      quality  = Math.max(minQuality,  quality  - 0.03);
      imgScale = Math.max(minImgScale, imgScale - 0.02);
    }

    if (quality <= minQuality && imgScale <= minImgScale) {
      addLogEntry(iteration, '⚠ Absolute minimum reached — returning best result', bestBytes, 'fail');
      setProgress(100, 'Minimum compression limit reached.');
      return new Blob([bestBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    await sleep(10);
  }

  setProgress(100, 'Max passes done — returning best result.');
  addLogEntry(iteration, 'Max iterations — returning best result', bestBytes, 'fail');
  return new Blob([bestBuffer || inputBytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ── Image Re-compression via Canvas ──────────────────────────────────────────
// scaleDown: 0.0–1.0 multiplier on pixel dimensions (1.0 = original, 0.1 = 10%)
async function recompressImage(arrayBuffer, quality, isPng, scaleDown = 1.0) {
  return new Promise((resolve) => {
    const blob = new Blob([arrayBuffer]);
    const url  = URL.createObjectURL(blob);
    const img  = new Image();

    img.onload = () => {
      // Clamp so canvas is never 0px
      const w = Math.max(1, Math.round(img.naturalWidth  * scaleDown));
      const h = Math.max(1, Math.round(img.naturalHeight * scaleDown));

      const canvas  = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx     = canvas.getContext('2d');

      // White background for transparent PNGs before JPEG conversion
      if (isPng) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }

      // drawImage with explicit dest dimensions performs the downscale
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      canvas.toBlob(
        (resultBlob) => {
          if (!resultBlob) { resolve(null); return; }
          resultBlob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Result Display ────────────────────────────────────────────────────────────
function showResult(finalSize, iterations, reductionPct) {
  progressPanel.classList.add('hidden');
  resultPanel.classList.remove('hidden');

  const targetMet = finalSize <= state.targetBytes;

  resultIcon.className = 'result-icon ' + (targetMet ? 'success' : 'warning');
  resultIcon.innerHTML = targetMet
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
         <polyline points="22 4 12 14.01 9 11.01"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
         <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
       </svg>`;

  resultTitle.textContent = targetMet
    ? '🎉 Compression Complete!'
    : '⚠️ Maximum Compression Reached';

  resultDesc.textContent = targetMet
    ? `Your file was compressed to ${formatBytes(finalSize)}, meeting the target of ${formatBytes(state.targetBytes)}.`
    : `This file cannot be reduced to ${formatBytes(state.targetBytes)} — it is the absolute smallest possible. The content itself (text, images) sets a hard floor.`;

  statFinalSize.textContent  = formatBytes(finalSize);
  statReduction.textContent  = reductionPct.toFixed(1) + '%';
  statIterations.textContent = iterations > 0 ? iterations : '—';
}

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  if (!state.resultBlob) return;
  const url  = URL.createObjectURL(state.resultBlob);
  const a    = document.createElement('a');
  const ext  = state.file.name.split('.').pop().toLowerCase();
  const base = state.file.name.replace(/\.[^.]+$/, '');
  a.href     = url;
  a.download = `${base}_compressed.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ── Reset ─────────────────────────────────────────────────────────────────────
btnReset.addEventListener('click', resetAll);

function resetAll() {
  state.file        = null;
  state.fileBytes   = null;
  state.resultBlob  = null;
  state.targetBytes = 0;
  state.iterations  = 0;
  state.originalSize = 0;

  fileInput.value        = '';
  iterationLog.innerHTML = '';
  progressFill.style.width = '0%';

  dropzone.classList.remove('hidden');
  fileInfoBar.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
}
