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
  const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'];
  if (!['pdf', 'docx', ...imageExts].includes(ext)) {
    alert('Please select a PDF, DOCX, or supported Image file.');
    return;
  }
  state.file = file;
  state.originalSize = file.size;

  fileName.textContent    = file.name;
  fileSizeOrig.textContent = formatBytes(file.size);

  if (ext === 'pdf') {
    fileTypeLabel.textContent    = 'PDF';
    fileIconWrap.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    fileIconWrap.className = 'file-icon-wrap';
  } else if (ext === 'docx') {
    fileTypeLabel.textContent    = 'DOCX';
    fileIconWrap.style.background = 'linear-gradient(135deg, #2563eb, #06b6d4)';
    fileIconWrap.className = 'file-icon-wrap docx';
  } else {
    fileTypeLabel.textContent    = ext.toUpperCase();
    fileIconWrap.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    fileIconWrap.className = 'file-icon-wrap';
  }

  dropzone.classList.add('hidden');
  document.getElementById('supportedFormats').classList.add('hidden');
  fileInfoBar.classList.remove('hidden');
  settingsPanel.classList.remove('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');

  // Set original size visual target card
  document.getElementById('visualOrigSize').textContent = formatBytes(file.size);
  updateVisualTarget();

  // Ensure settings view is correct based on default mode (normal)
  const targetSizeGroup = document.getElementById('targetSizeGroup');
  const visualFlow = document.querySelector('.target-visual-flow');
  const activeMode = document.querySelector('input[name="mode"]:checked').value;
  const isNormal = activeMode === 'normal';

  if (isNormal) {
    targetSizeGroup.classList.add('locked');
    visualFlow.classList.add('locked');
  } else {
    targetSizeGroup.classList.remove('locked');
    visualFlow.classList.remove('locked');
  }
  targetSizeInput.disabled = isNormal;
  targetUnitSel.disabled = isNormal;
}

// Mode radio buttons visibility toggler
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const targetSizeGroup = document.getElementById('targetSizeGroup');
    const visualFlow = document.querySelector('.target-visual-flow');
    const isNormal = e.target.value === 'normal';

    if (isNormal) {
      targetSizeGroup.classList.add('locked');
      visualFlow.classList.add('locked');
    } else {
      targetSizeGroup.classList.remove('locked');
      visualFlow.classList.remove('locked');
    }
    targetSizeInput.disabled = isNormal;
    targetUnitSel.disabled = isNormal;
  });
});

function updateVisualTarget() {
  const targetVal = parseFloat(targetSizeInput.value) || 0;
  const unit = targetUnitSel.value;
  document.getElementById('visualTargetSize').textContent = targetVal.toFixed(1) + ' ' + unit;
}

targetSizeInput.addEventListener('input', updateVisualTarget);
targetUnitSel.addEventListener('change', updateVisualTarget);

btnCompress.addEventListener('click', startCompression);

// ── Main Compression Entry ────────────────────────────────────────────────────
async function startCompression() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const targetVal = parseFloat(targetSizeInput.value);
  
  if (mode !== 'normal' && (isNaN(targetVal) || targetVal <= 0)) {
    alert('Please enter a valid target size greater than 0.');
    return;
  }

  const unit        = targetUnitSel.value;
  state.targetBytes = mode === 'normal' ? 0 : (unit === 'MB' ? targetVal * 1024 * 1024 : targetVal * 1024);
  state.iterations  = 0;

  settingsPanel.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  iterationLog.innerHTML = '';

  metricOriginal.textContent = formatBytes(state.originalSize);
  metricCurrent.textContent  = formatBytes(state.originalSize);
  metricTarget.textContent   = mode === 'normal' ? 'N/A' : formatBytes(state.targetBytes);
  setProgress(0, 'Reading file...');

  // Reset progress stats values
  document.getElementById('progressIteration').textContent = '0';
  document.getElementById('progressQuality').textContent = '80';
  document.getElementById('progressScale').textContent = '100%';
  document.getElementById('progressImagesCount').textContent = '0';
  document.getElementById('progressTimeRemaining').textContent = 'Calculating...';

  const reader = new FileReader();
  reader.onload = async (e) => {
    state.fileBytes = new Uint8Array(e.target.result);

    if (mode !== 'normal' && state.originalSize <= state.targetBytes) {
      addLogEntry(0, 'File already at or below target size', state.originalSize, 'success');
      state.resultBlob = new Blob([state.fileBytes], { type: state.file.type });
      showResult(state.originalSize, 0, 0);
      triggerDownload();
      return;
    }

    const ext = state.file.name.split('.').pop().toLowerCase();
    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'];
    try {
      let resultBlob;
      if (ext === 'pdf') {
        resultBlob = await compressPDF(state.fileBytes, state.targetBytes);
      } else if (ext === 'docx') {
        resultBlob = await compressDOCX(state.fileBytes, state.targetBytes);
      } else if (imageExts.includes(ext)) {
        resultBlob = await compressImageFile(state.fileBytes, state.targetBytes);
      } else {
        throw new Error('Unsupported file format');
      }
      
      state.resultBlob = resultBlob;
      showResult(
        resultBlob.size,
        state.iterations,
        ((state.originalSize - resultBlob.size) / state.originalSize * 100)
      );
      triggerDownload();
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
  let scale       = mode === 'normal' ? 1.0 : (mode === 'aggressive' ? 1.1 : 1.3);
  let quality     = mode === 'normal' ? 0.85 : (mode === 'aggressive' ? 0.65 : 0.75);

  let minScale, minQuality;
  if (mode === 'normal') {
    minScale = 0.70;
    minQuality = 0.50;
  } else if (mode === 'balanced') {
    minScale = 0.30;
    minQuality = 0.15;
  } else {
    minScale = 0.10;
    minQuality = 0.01;
  }
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
  document.getElementById('progressImagesCount').textContent = totalPages + ' pages';

  while (iteration < maxIter) {
    iteration++;
    state.iterations = iteration;

    // Update real-time progress panel stats
    document.getElementById('progressIteration').textContent = iteration;
    document.getElementById('progressQuality').textContent = Math.round(quality * 100);
    document.getElementById('progressScale').textContent = Math.round(scale * 100) + '%';

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

    // Update Est. Time Remaining (mock calculation based on iteration count vs maxIter)
    const elapsed = 0; // simplistic visual cue for PDF
    const remainingSteps = maxIter - iteration;
    document.getElementById('progressTimeRemaining').textContent = byteCount <= targetBytes ? 'Done' : `~${remainingSteps * 2}s`;

    // ── Target met or normal mode → return immediately ──
    if (mode === 'normal' || byteCount <= targetBytes) {
      setProgress(100, '✓ Compression complete!');
      document.getElementById('progressTimeRemaining').textContent = 'Done';
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
 * Unzips DOCX, re-compresses every embedded image at decreasing JPEG quality and dimensions,
 * according to the specified quality and scale ladders.
 */
async function compressDOCX(inputBytes, targetBytes) {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let qualityLadder = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 8, 6, 4, 2, 1];
  let scaleLadder = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];

  if (mode === 'normal') {
    qualityLadder = qualityLadder.filter(q => q >= 50);
    scaleLadder = scaleLadder.filter(s => s >= 0.70);
  } else if (mode === 'balanced') {
    qualityLadder = qualityLadder.filter(q => q >= 20);
    scaleLadder = scaleLadder.filter(s => s >= 0.30);
  }

  let qualityIdx = 0;
  let scaleIdx = 0;

  addLogEntry(0, 'Unzipping DOCX archive...', inputBytes.byteLength, 'info');
  setProgress(5, 'Reading DOCX structure...');

  const zip = await JSZip.loadAsync(inputBytes);

  // Locate word/media/* and process only supported extensions (jpg, jpeg, png, webp, bmp, tif, tiff)
  // Skipping SVG, EMF, WMF, icons, and unsupported image formats.
  const imgKeys = Object.keys(zip.files).filter(name => {
    const lower = name.toLowerCase();
    return lower.startsWith('word/media/') &&
           !zip.files[name].dir &&
           /\.(jpg|jpeg|png|webp|bmp|tif|tiff)$/.test(lower);
  });

  addLogEntry(0, `Found ${imgKeys.length} embedded image(s)`, inputBytes.byteLength, 'info');
  document.getElementById('progressImagesCount').textContent = imgKeys.length;

  // Pre-read all original image ArrayBuffers once to prevent degradation across iterations
  const origImgData = {};
  for (const key of imgKeys) {
    origImgData[key] = await zip.file(key).async('arraybuffer');
  }

  let bestBytes = null;
  let bestBuffer = null;
  let iteration = 0;

  const totalSteps = qualityLadder.length + scaleLadder.length - 1;
  const startTime = Date.now();

  while (true) {
    iteration++;
    state.iterations = iteration;

    const currentQuality = qualityLadder[qualityIdx];
    const currentScale = scaleLadder[scaleIdx];

    // Update real-time progress panel stats
    document.getElementById('progressIteration').textContent = iteration;
    document.getElementById('progressQuality').textContent = currentQuality;
    document.getElementById('progressScale').textContent = Math.round(currentScale * 100) + '%';

    // Calculate progress percentage
    const progressPct = 5 + ((qualityIdx + scaleIdx) / totalSteps) * 90;
    setProgress(progressPct, `Pass #${iteration} — Quality: ${currentQuality}, Scale: ${Math.round(currentScale * 100)}%`);

    // Fresh copy of the zip for this pass
    const freshZip = await JSZip.loadAsync(inputBytes);

    // Recompress every image
    const recompressPromises = imgKeys.map(async (key) => {
      const data = origImgData[key];
      const recompressed = await recompressImage(data, currentQuality / 100, currentScale);
      if (recompressed) {
        freshZip.file(key, recompressed, {
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        });
      }
    });

    await Promise.all(recompressPromises);

    // Generate the new ZIP
    const resultBuffer = await freshZip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    const byteCount = resultBuffer.byteLength;

    // Track best result
    if (bestBytes === null || byteCount < bestBytes) {
      bestBytes  = byteCount;
      bestBuffer = resultBuffer;
    }

    const isSuccess = byteCount <= targetBytes;
    const status = isSuccess ? 'success' : 'pass';
    addLogEntry(iteration, `Quality: ${currentQuality} · Scale: ${Math.round(currentScale * 100)}%`, byteCount, status);
    updateMetrics(byteCount);

    // Measure time and calculate Est. Time Remaining
    const elapsed = Date.now() - startTime;
    const avgTimePerIter = elapsed / iteration;
    const remainingSteps = totalSteps - (qualityIdx + scaleIdx);
    const estTimeRemainingMs = remainingSteps * avgTimePerIter;
    
    let timeStr = '0s';
    if (estTimeRemainingMs > 0) {
      const totalSec = Math.ceil(estTimeRemainingMs / 1000);
      if (totalSec >= 60) {
        timeStr = `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
      } else {
        timeStr = `${totalSec}s`;
      }
    }
    document.getElementById('progressTimeRemaining').textContent = isSuccess ? 'Done' : timeStr;

    if (mode === 'normal' || isSuccess) {
      setProgress(100, '✓ Compression complete!');
      document.getElementById('progressTimeRemaining').textContent = 'Done';
      return new Blob([resultBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    // Compression loop step update: quality reaches 1, then scale reduces.
    if (currentQuality > 1) {
      qualityIdx++;
    } else if (currentScale > 0.01) {
      scaleIdx++;
    } else {
      // quality = 1 and scale = 1% reached
      break;
    }

    await sleep(20);
  }

  setProgress(100, 'Minimum quality and scale reached.');
  addLogEntry(iteration, '⚠ Absolute minimum reached — returning best result', bestBytes, 'fail');
  document.getElementById('progressTimeRemaining').textContent = 'Finished';
  return new Blob([bestBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ── Image Re-compression via Canvas ──────────────────────────────────────────
/**
 * Loads image binary data into an HTML Canvas.
 * Automatically removes metadata.
 * Flattens transparency onto a white background when converting PNG to JPEG.
 */
async function recompressImage(arrayBuffer, quality, scaleDown = 1.0) {
  return new Promise((resolve) => {
    const blob = new Blob([arrayBuffer]);
    const url  = URL.createObjectURL(blob);
    const img  = new Image();

    img.onload = () => {
      const w = Math.max(1, Math.round(img.naturalWidth  * scaleDown));
      const h = Math.max(1, Math.round(img.naturalHeight * scaleDown));

      const canvas  = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx     = canvas.getContext('2d');

      // Flatten transparency onto white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      // Save as JPEG to satisfy flattening/quality compression requirements
      canvas.toBlob(
        (jpegBlob) => {
          if (!jpegBlob) { resolve(null); return; }
          jpegBlob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
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

  const mode = document.querySelector('input[name="mode"]:checked').value;
  const targetMet = mode === 'normal' || finalSize <= state.targetBytes;

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

  resultDesc.textContent = mode === 'normal'
    ? `Your file was successfully optimized to ${formatBytes(finalSize)} using standard compression.`
    : (targetMet
        ? `Your file was compressed to ${formatBytes(finalSize)}, meeting the target of ${formatBytes(state.targetBytes)}.`
        : `This file cannot be reduced to ${formatBytes(state.targetBytes)} — it is the absolute smallest possible. The content itself (text, images) sets a hard floor.`);

  statFinalSize.textContent  = formatBytes(finalSize);
  statReduction.textContent  = reductionPct.toFixed(1) + '%';
  statIterations.textContent = iterations > 0 ? iterations : '—';
}

// ── Download ──────────────────────────────────────────────────────────────────
function triggerDownload() {
  if (!state.resultBlob) return;
  const url  = URL.createObjectURL(state.resultBlob);
  const a    = document.createElement('a');
  let ext    = state.file.name.split('.').pop().toLowerCase();
  const base = state.file.name.replace(/\.[^.]+$/, '');
  
  const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'];
  if (imageExts.includes(ext)) {
    ext = 'jpg';
  }
  
  a.href     = url;
  a.download = `${base}-compressed.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

btnDownload.addEventListener('click', triggerDownload);

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
  document.getElementById('supportedFormats').classList.remove('hidden');
  fileInfoBar.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
}

// ── Image Compression ──────────────────────────────────────────────────────────
async function compressImageFile(inputBytes, targetBytes) {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let qualityLadder = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 8, 6, 4, 2, 1];
  let scaleLadder = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];

  if (mode === 'normal') {
    qualityLadder = qualityLadder.filter(q => q >= 50);
    scaleLadder = scaleLadder.filter(s => s >= 0.70);
  } else if (mode === 'balanced') {
    qualityLadder = qualityLadder.filter(q => q >= 20);
    scaleLadder = scaleLadder.filter(s => s >= 0.30);
  }

  let qualityIdx = 0;
  let scaleIdx = 0;

  addLogEntry(0, 'Loading image file...', inputBytes.byteLength, 'info');
  setProgress(10, 'Processing image...');
  document.getElementById('progressImagesCount').textContent = '1 image';

  let bestBytes = null;
  let bestBlob = null;
  let iteration = 0;

  const totalSteps = qualityLadder.length + scaleLadder.length - 1;
  const startTime = Date.now();

  while (true) {
    iteration++;
    state.iterations = iteration;

    const currentQuality = qualityLadder[qualityIdx];
    const currentScale = scaleLadder[scaleIdx];

    // Update real-time progress panel stats
    document.getElementById('progressIteration').textContent = iteration;
    document.getElementById('progressQuality').textContent = currentQuality;
    document.getElementById('progressScale').textContent = Math.round(currentScale * 100) + '%';

    // Calculate progress percentage
    const progressPct = 10 + ((qualityIdx + scaleIdx) / totalSteps) * 85;
    setProgress(progressPct, `Pass #${iteration} — Quality: ${currentQuality}, Scale: ${Math.round(currentScale * 100)}%`);

    // Compress raw image to JPEG blob using canvas
    const compressedBytes = await recompressImage(inputBytes, currentQuality / 100, currentScale);
    const compressedBlob = new Blob([compressedBytes], { type: 'image/jpeg' });
    const byteCount = compressedBlob.size;

    // Track best result
    if (bestBytes === null || byteCount < bestBytes) {
      bestBytes = byteCount;
      bestBlob = compressedBlob;
    }

    const isSuccess = byteCount <= targetBytes;
    const status = isSuccess ? 'success' : 'pass';
    addLogEntry(iteration, `Quality: ${currentQuality} · Scale: ${Math.round(currentScale * 100)}%`, byteCount, status);
    updateMetrics(byteCount);

    // Measure time and calculate Est. Time Remaining
    const elapsed = Date.now() - startTime;
    const avgTimePerIter = elapsed / iteration;
    const remainingSteps = totalSteps - (qualityIdx + scaleIdx);
    const estTimeRemainingMs = remainingSteps * avgTimePerIter;
    
    let timeStr = '0s';
    if (estTimeRemainingMs > 0) {
      const totalSec = Math.ceil(estTimeRemainingMs / 1000);
      if (totalSec >= 60) {
        timeStr = `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
      } else {
        timeStr = `${totalSec}s`;
      }
    }
    document.getElementById('progressTimeRemaining').textContent = isSuccess ? 'Done' : timeStr;

    if (isSuccess) {
      setProgress(100, '✓ Target reached!');
      return bestBlob;
    }

    // Compression loop step update: quality reaches 1, then scale reduces.
    if (currentQuality > 1) {
      qualityIdx++;
    } else if (currentScale > 0.01) {
      scaleIdx++;
    } else {
      break;
    }

    await sleep(20);
  }

  setProgress(100, 'Minimum quality and scale reached.');
  addLogEntry(iteration, '⚠ Absolute minimum reached — returning best result', bestBytes, 'fail');
  document.getElementById('progressTimeRemaining').textContent = 'Finished';
  return bestBlob;
}

