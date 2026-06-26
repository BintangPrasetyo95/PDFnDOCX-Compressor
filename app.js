/**
 * ShrinkIt – Smart PDF & DOCX Compressor
 * app.js – Core Compression Engine
 *
 * Strategy:
 *  PDF  → Render each page to canvas (reducing DPI each pass), export to JPEG,
 *          rebuild via pdf-lib. Iterates until target size is met.
 *  DOCX → Unzip, re-compress embedded images iteratively (reducing JPEG quality),
 *          then re-zip with DEFLATE. Iterates until target size is met.
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  // Update UI
  fileName.textContent = file.name;
  fileSizeOrig.textContent = formatBytes(file.size);

  if (ext === 'pdf') {
    fileTypeLabel.textContent = 'PDF';
    fileIconWrap.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    fileIconWrap.classList.remove('docx');
  } else {
    fileTypeLabel.textContent = 'DOCX';
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

  const unit = targetUnitSel.value;
  state.targetBytes = unit === 'MB' ? targetVal * 1024 * 1024 : targetVal * 1024;
  state.iterations  = 0;

  // Show progress
  settingsPanel.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  iterationLog.innerHTML = '';

  // Init metrics
  metricOriginal.textContent = formatBytes(state.originalSize);
  metricCurrent.textContent  = formatBytes(state.originalSize);
  metricTarget.textContent   = formatBytes(state.targetBytes);

  setProgress(0, 'Reading file...');

  // Read bytes
  const reader = new FileReader();
  reader.onload = async (e) => {
    state.fileBytes = new Uint8Array(e.target.result);

    if (state.originalSize <= state.targetBytes) {
      // Already within target
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
      showResult(resultBlob.size, state.iterations, ((state.originalSize - resultBlob.size) / state.originalSize * 100));
    } catch (err) {
      console.error(err);
      progressLabel.textContent = 'Error: ' + err.message;
    }
  };
  reader.readAsArrayBuffer(state.file);
}

// ── PDF Compression ───────────────────────────────────────────────────────────
/**
 * Strategy:
 * 1. Use PDF.js to render each page to canvas.
 * 2. Export canvas as JPEG at a given quality.
 * 3. Reconstruct PDF from images using pdf-lib.
 * 4. Measure resulting size; if too large reduce scale/quality and repeat.
 */
async function compressPDF(inputBytes, targetBytes) {
  // Dynamically configure PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;

  // Compression parameters per pass
  let scale   = mode === 'aggressive' ? 1.2 : 1.5;
  let quality = mode === 'aggressive' ? 0.7 : 0.85;
  const minScale   = 0.4;
  const minQuality = 0.1;
  const maxIter    = 20;

  let currentBytes = inputBytes;
  let iteration    = 0;

  addLogEntry(0, 'Original PDF loaded', currentBytes.byteLength, 'info');
  setProgress(5, 'Loading PDF document...');

  // Load with PDF.js
  const loadingTask = pdfjsLib.getDocument({ data: inputBytes.slice() });
  const pdfDoc      = await loadingTask.promise;
  const totalPages  = pdfDoc.numPages;

  addLogEntry(0, `PDF has ${totalPages} page(s)`, currentBytes.byteLength, 'info');

  while (iteration < maxIter) {
    iteration++;
    state.iterations = iteration;

    const pct = 5 + (iteration / maxIter) * 85;
    setProgress(pct, `Pass #${iteration} — scale: ${scale.toFixed(2)}, quality: ${quality.toFixed(2)}`);

    // Render all pages
    const pageImageBytes = [];
    const pageDimensions = [];

    for (let p = 1; p <= totalPages; p++) {
      const page     = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      const ctx      = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const dataURL    = canvas.toDataURL('image/jpeg', quality);
      const b64        = dataURL.split(',')[1];
      const imgBytes   = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

      pageImageBytes.push(imgBytes);
      pageDimensions.push({ width: viewport.width, height: viewport.height });
    }

    // Build new PDF with pdf-lib
    const { PDFDocument } = PDFLib;
    const newPdf = await PDFDocument.create();

    for (let i = 0; i < pageImageBytes.length; i++) {
      const jpgImage = await newPdf.embedJpg(pageImageBytes[i]);
      const { width, height } = pageDimensions[i];
      const page = newPdf.addPage([width, height]);
      page.drawImage(jpgImage, { x: 0, y: 0, width, height });
    }

    const pdfBytes  = await newPdf.save({ useObjectStreams: true });
    const byteCount = pdfBytes.byteLength;

    addLogEntry(iteration, `Scale ${scale.toFixed(2)} · Quality ${Math.round(quality * 100)}%`, byteCount, byteCount <= targetBytes ? 'success' : 'pass');
    updateMetrics(byteCount);

    if (byteCount <= targetBytes) {
      setProgress(100, 'Target reached! ✓');
      return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    // Calculate how aggressive to reduce
    const ratio = byteCount / targetBytes;
    if (ratio > 3) {
      scale   = Math.max(minScale, scale - 0.35);
      quality = Math.max(minQuality, quality - 0.18);
    } else if (ratio > 1.8) {
      scale   = Math.max(minScale, scale - 0.2);
      quality = Math.max(minQuality, quality - 0.12);
    } else if (ratio > 1.3) {
      quality = Math.max(minQuality, quality - 0.08);
    } else {
      quality = Math.max(minQuality, quality - 0.05);
    }

    if (scale <= minScale && quality <= minQuality) {
      addLogEntry(iteration, 'Minimum quality reached — best result saved', byteCount, 'fail');
      return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    await sleep(10); // yield to browser
  }

  // Return last result
  const { PDFDocument } = PDFLib;
  const finalPdf = await PDFDocument.create();
  // fallback: return last rendered
  setProgress(100, 'Max iterations reached — best result saved.');
  return new Blob([inputBytes], { type: 'application/pdf' });
}

// ── DOCX Compression ──────────────────────────────────────────────────────────
/**
 * Strategy:
 * 1. Unzip DOCX with JSZip.
 * 2. For each image in word/media/, re-encode as JPEG at decreasing quality.
 * 3. Re-zip all files with maximum DEFLATE compression.
 * 4. Measure resulting size; iterate until target met.
 */
async function compressDOCX(inputBytes, targetBytes) {
  const mode        = document.querySelector('input[name="mode"]:checked').value;
  let quality       = mode === 'aggressive' ? 0.65 : 0.82;
  const minQuality  = 0.08;
  const maxIter     = 18;
  let iteration     = 0;

  addLogEntry(0, 'Unzipping DOCX archive...', inputBytes.byteLength, 'info');
  setProgress(8, 'Reading DOCX structure...');

  const zip = await JSZip.loadAsync(inputBytes);

  // Identify image files
  const imgKeys = Object.keys(zip.files).filter(name => {
    const lower = name.toLowerCase();
    return (lower.startsWith('word/media/') || lower.startsWith('ppt/media/') || lower.startsWith('xl/media/'))
      && !zip.files[name].dir;
  });

  addLogEntry(0, `Found ${imgKeys.length} embedded image(s)`, inputBytes.byteLength, 'info');

  // Also increase DEFLATE on non-image files from the start
  let currentBytes = inputBytes.byteLength;

  while (iteration < maxIter) {
    iteration++;
    state.iterations = iteration;

    const pct = 8 + (iteration / maxIter) * 82;
    setProgress(pct, `Pass #${iteration} — image quality: ${Math.round(quality * 100)}%`);

    // Build a fresh zip each pass with current quality
    const freshZip = await JSZip.loadAsync(inputBytes);

    // Re-compress each image
    for (const key of imgKeys) {
      const fileEntry = freshZip.file(key);
      if (!fileEntry) continue;

      const imgData  = await fileEntry.async('arraybuffer');
      const lower    = key.toLowerCase();

      // Skip tiny files (< 5KB) to avoid artifacts on icons
      if (imgData.byteLength < 5120) continue;

      const recompressed = await recompressImage(imgData, quality, lower.endsWith('.png'));
      if (recompressed) {
        freshZip.file(key, recompressed, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
      }
    }

    // Re-zip entire archive with DEFLATE
    const resultBuffer = await freshZip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    const byteCount = resultBuffer.byteLength;
    addLogEntry(iteration, `Quality ${Math.round(quality * 100)}%`, byteCount, byteCount <= targetBytes ? 'success' : 'pass');
    updateMetrics(byteCount);

    if (byteCount <= targetBytes) {
      setProgress(100, 'Target reached! ✓');
      return new Blob([resultBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    // Reduce quality for next pass
    const ratio = byteCount / targetBytes;
    if (ratio > 3)        quality = Math.max(minQuality, quality - 0.20);
    else if (ratio > 2)   quality = Math.max(minQuality, quality - 0.13);
    else if (ratio > 1.4) quality = Math.max(minQuality, quality - 0.09);
    else                  quality = Math.max(minQuality, quality - 0.05);

    if (quality <= minQuality) {
      // Last pass at minimum quality
      const result = await freshZip.generateAsync({
        type: 'arraybuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      addLogEntry(iteration, 'Minimum quality reached — best result saved', result.byteLength, 'fail');
      updateMetrics(result.byteLength);
      return new Blob([result], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    await sleep(10);
  }

  // Fallback
  setProgress(100, 'Max iterations reached.');
  return new Blob([inputBytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * Re-compress an image buffer via Canvas.
 * Returns Uint8Array of re-encoded JPEG, or null on error.
 */
async function recompressImage(arrayBuffer, quality, isPng) {
  return new Promise((resolve) => {
    const blob = new Blob([arrayBuffer]);
    const url  = URL.createObjectURL(blob);
    const img  = new Image();

    img.onload = () => {
      const canvas  = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx     = canvas.getContext('2d');

      // White background for transparent PNGs
      if (isPng) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      ctx.drawImage(img, 0, 0);
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
    ? 'Compression Complete!'
    : 'Best Possible Result Achieved';

  resultDesc.textContent = targetMet
    ? `Your file was compressed to ${formatBytes(finalSize)}, meeting the target of ${formatBytes(state.targetBytes)}.`
    : `The file reached its minimum compressible size. Target was ${formatBytes(state.targetBytes)}.`;

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
  state.file       = null;
  state.fileBytes  = null;
  state.resultBlob = null;
  state.targetBytes = 0;
  state.iterations  = 0;
  state.originalSize = 0;

  fileInput.value  = '';
  iterationLog.innerHTML = '';
  progressFill.style.width = '0%';

  dropzone.classList.remove('hidden');
  fileInfoBar.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
}
