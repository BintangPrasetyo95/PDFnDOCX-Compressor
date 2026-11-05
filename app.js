/**
 * ShrinkIt – Smart PDF, DOCX, PPTX & Video Compressor
 * app.js – Core Compression Engine (v2 – Deep Compression)
 *
 * PDF   → PDF.js renders each page to canvas at decreasing scale + JPEG quality,
 *          rebuilt with pdf-lib. Iterates until target size met or absolute min hit.
 * DOCX  → JSZip unpacks, Canvas re-encodes every image at decreasing JPEG quality,
 *          re-packed with maximum DEFLATE. Iterates until target size met.
 * PPTX  → JSZip unpacks, Canvas re-encodes embedded images in ppt/media/,
 *          safely preserves all embedded videos/audios intact, re-packed with DEFLATE.
 * Video → Canvas + MediaRecorder encode stream at optimized bitrate/resolution.
 * Image → Direct canvas re-encode with quality & scale ladders.
 */

// ── Global State ──────────────────────────────────────────────────────────────
const state = {
  file: null,
  fileBytes: null,
  resultBlob: null,
  targetBytes: 0,
  iterations: 0,
  originalSize: 0,
  pptxContext: null,
  companionPdfDoc: null,
  pptxVideoPrefs: {},
  previewVideoUrls: [],
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

// PPTX Modal Elements
const pptxModal           = document.getElementById('pptxModal');
const pptxDetectedSlides  = document.getElementById('pptxDetectedSlides');
const pptxPdfDropzone     = document.getElementById('pptxPdfDropzone');
const pptxPdfInput        = document.getElementById('pptxPdfInput');
const pptxPdfDropLabel    = document.getElementById('pptxPdfDropLabel');
const pptxPdfStatus       = document.getElementById('pptxPdfStatus');
const pptxVideoSection    = document.getElementById('pptxVideoSection');
const pptxVideoCount      = document.getElementById('pptxVideoCount');
const pptxVideoList       = document.getElementById('pptxVideoList');
const pptxQuickActions    = document.getElementById('pptxQuickActions');
const btnQuickCompressAll = document.getElementById('btnQuickCompressAll');
const btnQuickKeepAll     = document.getElementById('btnQuickKeepAll');
const btnQuickFlattenAll  = document.getElementById('btnQuickFlattenAll');
const pptxSummaryBanner   = document.getElementById('pptxSummaryBanner');
const btnCancelPptxModal  = document.getElementById('btnCancelPptxModal');
const btnProceedPptxModal = document.getElementById('btnProceedPptxModal');

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

function formatTime(sec) {
  if (isNaN(sec) || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getSupportedVideoMimeType() {
  const types = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return '';
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
  const videoExts = ['mp4', 'webm', 'mov', 'm4v', 'mkv'];
  if (!['pdf', 'docx', 'pptx', ...videoExts, ...imageExts].includes(ext)) {
    alert('Please select a PDF, DOCX, PPTX, Video, or supported Image file.');
    return;
  }
  state.file = file;
  state.originalSize = file.size;

  // PPTX requires the deep-flattening companion PDF & video chooser workflow
  if (ext === 'pptx') {
    setupPPTXCompanionFlow(file);
    return;
  }

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
  } else if (videoExts.includes(ext)) {
    fileTypeLabel.textContent    = ext.toUpperCase();
    fileIconWrap.style.background = 'linear-gradient(135deg, #7c3aed, #a855f7)';
    fileIconWrap.className = 'file-icon-wrap video';
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

// ── PPTX Companion PDF & Interactive Video Chooser Setup ───────────────────────
function revokePreviewVideoUrls() {
  if (state.previewVideoUrls && state.previewVideoUrls.length > 0) {
    state.previewVideoUrls.forEach(url => {
      try { URL.revokeObjectURL(url); } catch (e) {}
    });
    state.previewVideoUrls = [];
  }
}

function updatePPTXSummaryBanner() {
  if (!state.pptxContext || !pptxSummaryBanner) return;
  const totalSlides = state.pptxContext.orderedSlides.length;
  const slideVideos = state.pptxContext.slideVideos;

  if (!state.companionPdfDoc) {
    pptxSummaryBanner.innerHTML = `Presentation contains <strong>${totalSlides}</strong> slide(s) and <strong>${slideVideos.length}</strong> embedded video(s). Please drop the companion PDF above to unlock compression.`;
    return;
  }

  let compressCount = 0;
  let keepCount = 0;
  let flattenCount = 0;

  slideVideos.forEach(v => {
    const action = state.pptxVideoPrefs[v.target] || 'compress';
    if (action === 'compress') compressCount++;
    else if (action === 'keep') keepCount++;
    else if (action === 'flatten') flattenCount++;
  });

  const playableSlideIndices = new Set();
  slideVideos.forEach(v => {
    const action = state.pptxVideoPrefs[v.target] || 'compress';
    if (action !== 'flatten') {
      playableSlideIndices.add(v.slideIndex);
    }
  });

  const totalFlattenedSlides = totalSlides - playableSlideIndices.size;
  const totalPlayableVideos = compressCount + keepCount;

  pptxSummaryBanner.innerHTML = `
    <strong>Ready:</strong> 
    <strong>${totalFlattenedSlides}</strong> slide(s) flattened into screenshots • 
    <strong>${playableSlideIndices.size}</strong> slide(s) kept playable with 
    <strong>${totalPlayableVideos}</strong> active video(s) 
    (${compressCount} compressed, ${keepCount} original untouched).
  `;
}

function syncAllActionPills() {
  document.querySelectorAll('.video-actions-segmented').forEach(group => {
    const target = group.dataset.target;
    const action = state.pptxVideoPrefs[target] || 'compress';
    group.querySelectorAll('.action-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.action === action);
    });
  });
}

if (btnQuickCompressAll) {
  btnQuickCompressAll.addEventListener('click', () => {
    if (!state.pptxContext) return;
    state.pptxContext.slideVideos.forEach(v => {
      state.pptxVideoPrefs[v.target] = 'compress';
    });
    syncAllActionPills();
    updatePPTXSummaryBanner();
  });
}

if (btnQuickKeepAll) {
  btnQuickKeepAll.addEventListener('click', () => {
    if (!state.pptxContext) return;
    state.pptxContext.slideVideos.forEach(v => {
      state.pptxVideoPrefs[v.target] = 'keep';
    });
    syncAllActionPills();
    updatePPTXSummaryBanner();
  });
}

if (btnQuickFlattenAll) {
  btnQuickFlattenAll.addEventListener('click', () => {
    if (!state.pptxContext) return;
    state.pptxContext.slideVideos.forEach(v => {
      state.pptxVideoPrefs[v.target] = 'flatten';
    });
    syncAllActionPills();
    updatePPTXSummaryBanner();
  });
}

async function setupPPTXCompanionFlow(file) {
  try {
    dropzone.classList.add('hidden');
    document.getElementById('supportedFormats').classList.add('hidden');

    revokePreviewVideoUrls();

    const arrayBuffer = await file.arrayBuffer();
    state.fileBytes = new Uint8Array(arrayBuffer);
    const zip = await JSZip.loadAsync(state.fileBytes);

    const presRelsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('text');
    const presXml = await zip.file('ppt/presentation.xml')?.async('text');

    // Slide dimensions
    let cx = '12192000';
    let cy = '6858000';
    if (presXml) {
      const cxMatch = presXml.match(/<p:sldSz[^>]*cx="(\d+)"/i);
      const cyMatch = presXml.match(/<p:sldSz[^>]*cy="(\d+)"/i);
      if (cxMatch) cx = cxMatch[1];
      if (cyMatch) cy = cyMatch[1];
    }

    // Ordered slides detection
    const rIdToTarget = {};
    if (presRelsXml) {
      const relRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/slide"[^>]*Target="([^"]+)"/gi;
      let m;
      while ((m = relRegex.exec(presRelsXml)) !== null) {
        let target = m[2].replace(/^\/?ppt\//, '');
        if (!target.startsWith('slides/')) target = 'slides/' + target;
        rIdToTarget[m[1]] = 'ppt/' + target;
      }
    }

    let orderedSlides = [];
    if (presXml) {
      const sldIdRegex = /<p:sldId[^>]*r:id="([^"]+)"/gi;
      let m;
      while ((m = sldIdRegex.exec(presXml)) !== null) {
        const path = rIdToTarget[m[1]];
        if (path && zip.file(path)) orderedSlides.push(path);
      }
    }
    if (orderedSlides.length === 0) {
      orderedSlides = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a,b) => parseInt(a.match(/slide(\d+)\.xml/i)[1]) - parseInt(b.match(/slide(\d+)\.xml/i)[1]));
    }

    if (orderedSlides.length === 0) {
      alert('Could not find any slides in this PPTX presentation.');
      resetAll();
      return;
    }

    // Detect videos on each slide and create playable preview URLs
    const slideVideos = [];
    for (let i = 0; i < orderedSlides.length; i++) {
      const slidePath = orderedSlides[i];
      const slideNum = i + 1;
      const relsPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      const relsFile = zip.file(relsPath);
      if (relsFile) {
        const relsText = await relsFile.async('text');
        const videoRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+\.(mp4|mov|wmv|avi|m4v|webm|mkv|flv))"/gi;
        let vm;
        while ((vm = videoRegex.exec(relsText)) !== null) {
          const relId = vm[1];
          const rawTarget = vm[2];
          const cleanTarget = rawTarget.replace(/^\.\.\//, 'ppt/');
          const vFile = zip.file(cleanTarget);
          let size = 0;
          let videoUrl = null;

          if (vFile) {
            const vBytes = await vFile.async('uint8array');
            size = vBytes.byteLength;
            const ext = cleanTarget.split('.').pop().toLowerCase();
            let mime = 'video/mp4';
            if (ext === 'webm') mime = 'video/webm';
            else if (ext === 'mov') mime = 'video/quicktime';
            else if (ext === 'm4v') mime = 'video/x-m4v';
            else if (ext === 'ogg' || ext === 'ogv') mime = 'video/ogg';

            const vBlob = new Blob([vBytes], { type: mime });
            videoUrl = URL.createObjectURL(vBlob);
            state.previewVideoUrls.push(videoUrl);
          }

          slideVideos.push({
            slideIndex: i,
            slideNum,
            slidePath,
            relsPath,
            relId,
            target: cleanTarget,
            fileName: cleanTarget.split('/').pop(),
            size,
            videoUrl
          });
        }
      }
    }

    state.pptxContext = {
      zip,
      orderedSlides,
      slideVideos,
      cx,
      cy,
      originalFile: file
    };

    state.companionPdfDoc = null;
    state.pptxVideoPrefs = {};

    pptxDetectedSlides.textContent = orderedSlides.length;
    pptxPdfStatus.className = 'modal-status-badge pending';
    pptxPdfStatus.textContent = `Awaiting companion PDF (${orderedSlides.length} pages)...`;
    pptxPdfDropLabel.textContent = 'Drop companion PDF here or click to browse';
    pptxPdfInput.value = '';
    btnProceedPptxModal.disabled = true;

    pptxVideoCount.textContent = slideVideos.length;
    pptxVideoList.innerHTML = '';

    if (slideVideos.length > 0) {
      if (pptxQuickActions) pptxQuickActions.style.display = 'flex';

      slideVideos.forEach((v) => {
        state.pptxVideoPrefs[v.target] = 'compress';

        const card = document.createElement('div');
        card.className = 'video-interactive-card';
        card.innerHTML = `
          <div class="video-card-header">
            <div class="video-card-title-group">
              <span class="slide-num-pill">Slide ${v.slideNum}</span>
              <span class="video-filename" title="${v.fileName}">${v.fileName}</span>
            </div>
            <span class="video-size-pill">${formatBytes(v.size)}</span>
          </div>

          <div class="video-card-body">
            <div class="video-preview-wrapper">
              <span class="preview-label">🎬 Embedded Video Preview</span>
              ${v.videoUrl 
                ? `<video class="video-player-preview" controls preload="metadata" playsinline src="${v.videoUrl}"></video>`
                : `<div class="video-player-preview" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.75rem;">Preview unavailable</div>`
              }
            </div>
            <div class="slide-preview-wrapper">
              <span class="preview-label">📄 Slide Context Preview</span>
              <canvas id="slideThumb_${v.slideNum}" class="slide-thumb-canvas" width="240" height="135"></canvas>
            </div>
          </div>

          <div class="video-actions-segmented" data-target="${v.target}">
            <button type="button" class="action-pill active" data-action="compress" title="Keep slide and video playable, re-encode video to reduce size">
              ⚡ Compress &amp; Keep
            </button>
            <button type="button" class="action-pill" data-action="keep" title="Keep slide and video playable with original untouched video quality">
              🛡️ Keep Original
            </button>
            <button type="button" class="action-pill" data-action="flatten" title="Flatten this slide into a static screenshot like the rest of the presentation">
              🖼️ Flatten Slide
            </button>
          </div>
        `;
        pptxVideoList.appendChild(card);

        // Draw initial placeholder on thumb canvas
        const canvas = card.querySelector(`#slideThumb_${v.slideNum}`);
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#111';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#666';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Awaiting Companion PDF', canvas.width / 2, canvas.height / 2);
        }

        // Add pill click listeners
        card.querySelectorAll('.action-pill').forEach(btn => {
          btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            state.pptxVideoPrefs[v.target] = action;
            card.querySelectorAll('.action-pill').forEach(b => {
              b.classList.toggle('active', b === btn);
            });
            updatePPTXSummaryBanner();
          });
        });
      });
    } else {
      if (pptxQuickActions) pptxQuickActions.style.display = 'none';
      pptxVideoList.innerHTML = `
        <div style="font-size:0.8rem; color: var(--text-secondary); padding: 8px 0;">
          No embedded videos detected in this presentation. All ${orderedSlides.length} slides will be flattened into screenshots.
        </div>
      `;
    }

    updatePPTXSummaryBanner();
    pptxModal.classList.remove('hidden');

  } catch (err) {
    console.error('Error analyzing PPTX:', err);
    alert('Error reading PPTX file: ' + err.message);
    resetAll();
  }
}

// PPTX Companion PDF Dropzone Listeners
pptxPdfDropzone.addEventListener('dragover', (e) => { e.preventDefault(); pptxPdfDropzone.classList.add('drag-over'); });
pptxPdfDropzone.addEventListener('dragleave', () => pptxPdfDropzone.classList.remove('drag-over'));
pptxPdfDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  pptxPdfDropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleCompanionPdf(file);
});
pptxPdfDropzone.addEventListener('click', () => pptxPdfInput.click());
pptxPdfInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleCompanionPdf(e.target.files[0]);
});

async function handleCompanionPdf(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    pptxPdfStatus.className = 'modal-status-badge error';
    pptxPdfStatus.textContent = '❌ Please select a valid PDF file.';
    btnProceedPptxModal.disabled = true;
    return;
  }

  pptxPdfStatus.className = 'modal-status-badge pending';
  pptxPdfStatus.textContent = 'Reading and verifying PDF pages...';

  try {
    const bytes = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
    const pdfDoc = await loadingTask.promise;
    const expectedPages = state.pptxContext.orderedSlides.length;

    if (pdfDoc.numPages === expectedPages) {
      state.companionPdfDoc = pdfDoc;
      pptxPdfStatus.className = 'modal-status-badge success';
      pptxPdfStatus.textContent = `✓ Perfect match! ${pdfDoc.numPages} PDF pages match ${expectedPages} slides.`;
      pptxPdfDropLabel.textContent = `Selected: ${file.name} (${pdfDoc.numPages} pages)`;
      btnProceedPptxModal.disabled = false;
      updatePPTXSummaryBanner();

      // Render slide context preview thumbnails
      if (state.pptxContext && state.pptxContext.slideVideos) {
        for (const v of state.pptxContext.slideVideos) {
          try {
            const page = await pdfDoc.getPage(v.slideNum);
            const thumbCanvas = document.getElementById(`slideThumb_${v.slideNum}`);
            if (thumbCanvas) {
              const viewport = page.getViewport({ scale: 0.35 });
              thumbCanvas.width = viewport.width;
              thumbCanvas.height = viewport.height;
              const tCtx = thumbCanvas.getContext('2d');
              tCtx.fillStyle = '#ffffff';
              tCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
              await page.render({ canvasContext: tCtx, viewport }).promise;
            }
          } catch (renderErr) {
            console.warn('Could not render slide thumbnail for slide ' + v.slideNum, renderErr);
          }
        }
      }
    } else {
      state.companionPdfDoc = null;
      pptxPdfStatus.className = 'modal-status-badge error';
      pptxPdfStatus.textContent = `❌ Page mismatch: PDF has ${pdfDoc.numPages} page(s), but PPTX has ${expectedPages} slides.`;
      btnProceedPptxModal.disabled = true;
      updatePPTXSummaryBanner();
    }
  } catch (err) {
    console.error(err);
    pptxPdfStatus.className = 'modal-status-badge error';
    pptxPdfStatus.textContent = '❌ Error loading PDF: ' + err.message;
    btnProceedPptxModal.disabled = true;
    updatePPTXSummaryBanner();
  }
}

btnCancelPptxModal.addEventListener('click', () => {
  revokePreviewVideoUrls();
  pptxModal.classList.add('hidden');
  resetAll();
});

btnProceedPptxModal.addEventListener('click', () => {
  if (!state.companionPdfDoc) return;

  // Ensure all videos have a preference set
  if (state.pptxContext && state.pptxContext.slideVideos) {
    state.pptxContext.slideVideos.forEach(v => {
      if (!state.pptxVideoPrefs[v.target]) {
        state.pptxVideoPrefs[v.target] = 'compress';
      }
    });
  }

  pptxModal.classList.add('hidden');

  // Proceed to compression settings view
  fileTypeLabel.textContent = 'PPTX';
  fileIconWrap.style.background = 'linear-gradient(135deg, #ea580c, #f97316)';
  fileIconWrap.className = 'file-icon-wrap pptx';
  fileName.textContent = `${state.file.name} (+ Companion PDF)`;
  fileSizeOrig.textContent = formatBytes(state.originalSize);

  document.getElementById('supportedFormats').classList.add('hidden');
  fileInfoBar.classList.remove('hidden');
  settingsPanel.classList.remove('hidden');
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');

  document.getElementById('visualOrigSize').textContent = formatBytes(state.originalSize);
  updateVisualTarget();

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
});

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

  const ext = state.file.name.split('.').pop().toLowerCase();
  const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'];
  const videoExts = ['mp4', 'webm', 'mov', 'm4v', 'mkv'];

  // Fast-path: if file is already at or below target size
  if (mode !== 'normal' && state.originalSize <= state.targetBytes) {
    addLogEntry(0, 'File already at or below target size', state.originalSize, 'success');
    state.resultBlob = state.file;
    showResult(state.originalSize, 0, 0);
    triggerDownload();
    return;
  }

  // Standalone video files are processed directly via stream/canvas without needing full ArrayBuffer copy
  if (videoExts.includes(ext)) {
    try {
      const resultBlob = await compressVideoFile(state.file, state.targetBytes);
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
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    state.fileBytes = new Uint8Array(e.target.result);

    try {
      let resultBlob;
      if (ext === 'pdf') {
        resultBlob = await compressPDF(state.fileBytes, state.targetBytes);
      } else if (ext === 'docx') {
        resultBlob = await compressDOCX(state.fileBytes, state.targetBytes);
      } else if (ext === 'pptx') {
        resultBlob = await compressPPTXDeepFlatten(
          state.fileBytes,
          state.companionPdfDoc,
          state.pptxVideoPrefs,
          state.targetBytes,
          state.pptxContext
        );
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

// ── PPTX Deep-Flattening Engine ───────────────────────────────────────────────
/**
 * Transforms PPTX:
 * 1. Non-video slides (and flattened video slides) have all XML shapes and animations removed,
 *    replaced by a full-bleed crisp screenshot rendered from companion PDF.
 * 2. Video slides chosen to stay playable remain intact with their video containers.
 * 3. Videos marked for compression are compressed via MediaRecorder.
 * 4. All unreferenced legacy slide media is purged from the ZIP.
 * 5. Iterates quality & scale ladders to achieve the desired target size.
 */
async function compressPPTXDeepFlatten(inputBytes, pdfDoc, videoPrefs, targetBytes, pptxContext) {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let qualityLadder = [90, 80, 70, 60, 50, 40, 30, 20, 15, 10, 5, 2, 1];
  let scaleLadder = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];

  if (mode === 'normal') {
    qualityLadder = [85];
    scaleLadder = [1.0];
  } else if (mode === 'balanced') {
    qualityLadder = qualityLadder.filter(q => q >= 25);
    scaleLadder = scaleLadder.filter(s => s >= 0.35);
  }

  const { orderedSlides, slideVideos, cx, cy } = pptxContext;
  const totalSlides = orderedSlides.length;

  addLogEntry(0, `Initializing Deep-Flattening for ${totalSlides} slides...`, inputBytes.byteLength, 'info');
  setProgress(5, 'Analyzing slide relationships & videos...');

  // Identify which slides are Video Exceptions (kept playable)
  // Maps slideIndex -> { target, action, fileName }
  const videoExceptionSlides = new Map();
  slideVideos.forEach(v => {
    const action = (videoPrefs && videoPrefs[v.target]) || 'compress';
    if (action !== 'flatten') {
      videoExceptionSlides.set(v.slideIndex, { target: v.target, action, fileName: v.fileName });
    }
  });

  const flattenedCount = totalSlides - videoExceptionSlides.size;
  addLogEntry(0, `Flattening ${flattenedCount} slide(s) to screenshots; ${videoExceptionSlides.size} video slide(s) preserved`, inputBytes.byteLength, 'info');
  document.getElementById('progressImagesCount').textContent = `${flattenedCount} screenshots`;

  // ── Step 1: Pre-compress eligible videos once and cache results ──
  const compressedVideoCache = {};
  const baseZip = await JSZip.loadAsync(inputBytes);

  for (const [sIdx, vInfo] of videoExceptionSlides.entries()) {
    if (vInfo.action === 'compress' && !compressedVideoCache[vInfo.target]) {
      const vFile = baseZip.file(vInfo.target);
      if (vFile) {
        setProgress(10, `Compressing video: ${vInfo.fileName}...`);
        addLogEntry(0, `Compressing embedded video: ${vInfo.fileName}...`, inputBytes.byteLength, 'info');
        try {
          const rawVidBytes = await vFile.async('uint8array');
          const vidBlob = new Blob([rawVidBytes], { type: 'video/mp4' });
          const vidTarget = targetBytes > 0 ? Math.round(targetBytes * 0.6) : 0;
          const compressedBlob = await compressVideoFile(vidBlob, vidTarget);
          const compressedBuffer = await compressedBlob.arrayBuffer();
          compressedVideoCache[vInfo.target] = new Uint8Array(compressedBuffer);
          addLogEntry(0, `Compressed ${vInfo.fileName}: ${formatBytes(rawVidBytes.byteLength)} → ${formatBytes(compressedBuffer.byteLength)}`, compressedBuffer.byteLength, 'success');
        } catch (vidErr) {
          console.warn('Video compression fallback (keeping original):', vidErr);
          addLogEntry(0, `Video compression skipped for ${vInfo.fileName} (kept original)`, inputBytes.byteLength, 'pass');
        }
      }
    }
  }

  // ── Step 2: Flattening & Multi-pass Image Optimization ──
  let bestBytes = null;
  let bestBuffer = null;
  let iteration = 0;
  let qualityIdx = 0;
  let scaleIdx = 0;

  const totalSteps = qualityLadder.length + scaleLadder.length - 1;
  const startTime = Date.now();

  while (true) {
    iteration++;
    state.iterations = iteration;

    const currentQuality = qualityLadder[qualityIdx];
    const currentScale = scaleLadder[scaleIdx];

    document.getElementById('progressIteration').textContent = iteration;
    document.getElementById('progressQuality').textContent = currentQuality;
    document.getElementById('progressScale').textContent = Math.round(currentScale * 100) + '%';

    const progressPct = 15 + ((qualityIdx + scaleIdx) / totalSteps) * 80;
    setProgress(progressPct, `Pass #${iteration} — Quality: ${currentQuality}, Scale: ${Math.round(currentScale * 100)}%`);

    const freshZip = await JSZip.loadAsync(inputBytes);

    // Ensure [Content_Types].xml supports JPG/JPEG MIME types
    let contentTypes = await freshZip.file('[Content_Types].xml')?.async('text');
    if (contentTypes) {
      let modifiedTypes = false;
      if (!contentTypes.includes('Extension="jpg"') && !contentTypes.includes('Extension="JPG"')) {
        contentTypes = contentTypes.replace('</Types>', '  <Default Extension="jpg" ContentType="image/jpeg"/>\n</Types>');
        modifiedTypes = true;
      }
      if (!contentTypes.includes('Extension="jpeg"') && !contentTypes.includes('Extension="JPEG"')) {
        contentTypes = contentTypes.replace('</Types>', '  <Default Extension="jpeg" ContentType="image/jpeg"/>\n</Types>');
        modifiedTypes = true;
      }
      if (modifiedTypes) {
        freshZip.file('[Content_Types].xml', contentTypes);
      }
    }

    // Apply pre-compressed videos
    for (const [target, vBytes] of Object.entries(compressedVideoCache)) {
      freshZip.file(target, vBytes, {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
    }

    // List of active media to keep (prevents deleting active videos & their preview posters)
    const activeMediaToKeep = new Set();
    for (const [sIdx, vInfo] of videoExceptionSlides.entries()) {
      activeMediaToKeep.add(vInfo.target.toLowerCase());
      const preservedSlidePath = orderedSlides[sIdx];
      const preservedRelsPath = preservedSlidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      const relsFile = freshZip.file(preservedRelsPath);
      if (relsFile) {
        const relsText = await relsFile.async('text');
        const targetRegex = /Target="([^"]+)"/gi;
        let tm;
        while ((tm = targetRegex.exec(relsText)) !== null) {
          let t = tm[1].replace(/^\.\.\//, 'ppt/');
          activeMediaToKeep.add(t.toLowerCase());
        }
      }
    }

    // Render each slide from PDF
    for (let i = 1; i <= totalSlides; i++) {
      const slideIndex = i - 1;
      const slidePath = orderedSlides[slideIndex];
      const relsPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';

      // Check if this slide is a Video Exception (kept playable)
      if (videoExceptionSlides.has(slideIndex)) {
        continue;
      }

      // Render PDF page for this slide
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: currentScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Extract high-quality binary JPEG bytes safely via canvas.toBlob
      const jpgBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', currentQuality / 100));
      const jpgBuffer = await jpgBlob.arrayBuffer();
      const jpgBytes = new Uint8Array(jpgBuffer);

      const bgRelPath = `../media/slide_bg_${i}.jpg`;
      const bgZipPath = `ppt/media/slide_bg_${i}.jpg`;
      activeMediaToKeep.add(bgZipPath.toLowerCase());

      freshZip.file(bgZipPath, jpgBytes, {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });

      // Update slide rels with numeric rId2 (strictly required by PowerPoint)
      let layoutTarget = '../slideLayouts/slideLayout1.xml';
      const origRelsFile = freshZip.file(relsPath);
      if (origRelsFile) {
        const origRelsText = await origRelsFile.async('text');
        const layoutMatch = origRelsText.match(/<Relationship[^>]*Type="[^"]*\/slideLayout"[^>]*Target="([^"]+)"[^>]*\/?>/i);
        if (layoutMatch) layoutTarget = layoutMatch[1];
      }

      const flatRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${layoutTarget}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${bgRelPath}"/>
</Relationships>`;
      freshZip.file(relsPath, flatRelsXml);

      // Update slide XML (full-bleed screenshot, r:embed="rId2", all animations/shapes removed)
      const flatSlideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="2" name="Slide Screenshot"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="${cx}" cy="${cy}"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMap/></p:clrMapOvr>
</p:sld>`;
      freshZip.file(slidePath, flatSlideXml);
    }

    // Clean up all unused legacy media files from flattened slides
    const allZipFiles = Object.keys(freshZip.files);
    for (const fName of allZipFiles) {
      const lower = fName.toLowerCase();
      if (lower.startsWith('ppt/media/') && !freshZip.files[fName].dir) {
        if (!activeMediaToKeep.has(lower)) {
          freshZip.remove(fName);
        }
      }
    }

    // Generate compressed PPTX archive
    const resultBuffer = await freshZip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    const byteCount = resultBuffer.byteLength;

    if (bestBytes === null || byteCount < bestBytes) {
      bestBytes = byteCount;
      bestBuffer = resultBuffer;
    }

    const isSuccess = targetBytes > 0 ? byteCount <= targetBytes : true;
    const status = isSuccess ? 'success' : 'pass';
    addLogEntry(iteration, `Quality: ${currentQuality} · Scale: ${Math.round(currentScale * 100)}%`, byteCount, status);
    updateMetrics(byteCount);

    const elapsed = Date.now() - startTime;
    const avgTimePerIter = elapsed / iteration;
    const remainingSteps = totalSteps - (qualityIdx + scaleIdx);
    const estTimeRemainingMs = remainingSteps * avgTimePerIter;

    let timeStr = '0s';
    if (estTimeRemainingMs > 0) {
      const totalSec = Math.ceil(estTimeRemainingMs / 1000);
      timeStr = totalSec >= 60 ? `${Math.floor(totalSec / 60)}m ${totalSec % 60}s` : `${totalSec}s`;
    }
    document.getElementById('progressTimeRemaining').textContent = isSuccess ? 'Done' : timeStr;

    if (mode === 'normal' || (targetBytes > 0 && isSuccess)) {
      setProgress(100, '✓ Deep-flattening compression complete!');
      document.getElementById('progressTimeRemaining').textContent = 'Done';
      return new Blob([resultBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
    }

    if (currentQuality > 5) {
      qualityIdx++;
    } else if (currentScale > 0.05) {
      scaleIdx++;
    } else {
      break;
    }

    await sleep(20);
  }

  setProgress(100, 'Minimum quality reached.');
  addLogEntry(iteration, '⚠ Returning best compressed result', bestBytes, 'fail');
  document.getElementById('progressTimeRemaining').textContent = 'Finished';
  return new Blob([bestBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

// ── Video Compression via Canvas & MediaRecorder ────────────────────────────
/**
 * Compresses standalone video files (MP4, WebM, MOV, MKV, etc.) client-side.
 * Dynamically scales resolution and calculates video bitrate based on duration & target size.
 * Renders video frames onto a canvas and records silently via Web Audio API destination.
 */
async function compressVideoFile(file, targetBytes) {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not supported in this browser.');
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;
  
  addLogEntry(0, 'Loading video file...', file.size, 'info');
  setProgress(5, 'Analyzing video tracks & metadata...');

  const videoUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = videoUrl;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Failed to load video file or unsupported video codec.'));
    setTimeout(() => reject(new Error('Timeout loading video metadata')), 15000);
  });

  const duration = video.duration || 1;
  const origW = video.videoWidth || 1280;
  const origH = video.videoHeight || 720;
  
  addLogEntry(0, `Video: ${origW}x${origH}, duration: ${formatTime(duration)}`, file.size, 'info');

  // Set up silent audio routing using Web Audio API to prevent loud speaker playback
  let audioCtx = null;
  let audioDest = null;
  let hasAudio = false;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      const audioSource = audioCtx.createMediaElementSource(video);
      audioDest = audioCtx.createMediaStreamDestination();
      audioSource.connect(audioDest);
      if (audioDest.stream.getAudioTracks().length > 0) {
        hasAudio = true;
      }
    }
  } catch (err) {
    console.warn('Audio routing notice:', err);
    hasAudio = false;
  }

  // Calculate bitrates & dimensions
  let scale = 1.0;
  let videoBps = 1500000; // default 1.5 Mbps
  const audioBps = hasAudio ? 96000 : 0;

  if (mode !== 'normal' && targetBytes > 0) {
    const totalBits = targetBytes * 8;
    const targetTotalBps = totalBits / duration;
    videoBps = Math.max(100000, targetTotalBps - audioBps);

    if (targetTotalBps < 400000) {
      scale = Math.min(1.0, 360 / Math.min(origW, origH));
    } else if (targetTotalBps < 900000) {
      scale = Math.min(1.0, 480 / Math.min(origW, origH));
    } else if (targetTotalBps < 1800000) {
      scale = Math.min(1.0, 720 / Math.min(origW, origH));
    } else {
      scale = Math.min(1.0, 1080 / Math.min(origW, origH));
    }
  } else {
    // Normal mode
    const origBps = (file.size * 8) / duration;
    videoBps = Math.min(Math.max(origBps * 0.45, 600000), 2000000);
    if (Math.min(origW, origH) > 720) {
      scale = 720 / Math.min(origW, origH);
    }
  }

  if (mode === 'aggressive') {
    videoBps = Math.max(80000, videoBps * 0.7);
    scale = Math.min(scale, 480 / Math.min(origW, origH));
  }

  let targetW = Math.max(160, Math.round((origW * scale) / 2) * 2);
  let targetH = Math.max(120, Math.round((origH * scale) / 2) * 2);

  document.getElementById('progressIteration').textContent = '1';
  document.getElementById('progressQuality').textContent = `${Math.round(videoBps / 1000)}k`;
  document.getElementById('progressScale').textContent = `${targetW}x${targetH}`;
  document.getElementById('progressImagesCount').textContent = '1 video';

  addLogEntry(
    1,
    `Encoding to ${targetW}x${targetH} @ ~${Math.round(videoBps / 1000)} kbps`,
    file.size,
    'pass'
  );

  // Set up Canvas & Stream
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');

  const fps = 30;
  const canvasStream = canvas.captureStream(fps);
  const tracks = [...canvasStream.getVideoTracks()];

  if (hasAudio && audioDest) {
    const aTracks = audioDest.stream.getAudioTracks();
    if (aTracks.length > 0) {
      tracks.push(aTracks[0]);
    }
  }

  const recordStream = new MediaStream(tracks);

  // Find supported MIME type (prefer MP4, fallback to WebM)
  const mimeType = getSupportedVideoMimeType();
  const recorderOptions = {
    videoBitsPerSecond: Math.round(videoBps),
  };
  if (mimeType) {
    recorderOptions.mimeType = mimeType;
  }
  if (hasAudio) {
    recorderOptions.audioBitsPerSecond = audioBps;
  }

  let recorder;
  try {
    recorder = new MediaRecorder(recordStream, recorderOptions);
  } catch (err) {
    recorder = new MediaRecorder(recordStream);
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const compressionPromise = new Promise((resolve, reject) => {
    let isFinished = false;
    let animId = null;

    recorder.onstop = () => {
      isFinished = true;
      if (animId) {
        if ('cancelVideoFrameCallback' in video) {
          video.cancelVideoFrameCallback(animId);
        } else {
          cancelAnimationFrame(animId);
        }
      }
      try { video.pause(); } catch (_) {}
      recordStream.getTracks().forEach(t => t.stop());
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      URL.revokeObjectURL(videoUrl);

      const finalBlob = new Blob(chunks, { type: recorder.mimeType || 'video/mp4' });
      resolve(finalBlob);
    };

    recorder.onerror = (e) => {
      isFinished = true;
      recordStream.getTracks().forEach(t => t.stop());
      URL.revokeObjectURL(videoUrl);
      reject(e.error || new Error('Video recording error'));
    };

    video.onended = () => {
      if (recorder.state === 'recording') {
        recorder.stop();
      }
    };

    function drawLoop() {
      if (isFinished) return;
      ctx.drawImage(video, 0, 0, targetW, targetH);

      const current = video.currentTime;
      const pct = Math.min(99, Math.round((current / duration) * 90) + 5);
      const remainingSec = Math.max(0, Math.ceil(duration - current));

      setProgress(pct, `Compressing video... ${formatTime(current)} / ${formatTime(duration)}`);
      document.getElementById('progressTimeRemaining').textContent = `~${remainingSec}s`;

      if (video.ended || (duration > 0 && current >= duration - 0.05)) {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
        return;
      }

      if ('requestVideoFrameCallback' in video) {
        animId = video.requestVideoFrameCallback(drawLoop);
      } else {
        animId = requestAnimationFrame(drawLoop);
      }
    }

    recorder.start(250);
    video.currentTime = 0;
    
    // Fast-forward playback if video has no audio
    if (!hasAudio) {
      video.playbackRate = 2.0;
    }

    video.play().then(() => {
      if ('requestVideoFrameCallback' in video) {
        animId = video.requestVideoFrameCallback(drawLoop);
      } else {
        animId = requestAnimationFrame(drawLoop);
      }
    }).catch(async (playErr) => {
      // Autoplay fallback: mute video if audio policy blocked playback
      try {
        video.muted = true;
        await video.play();
        if ('requestVideoFrameCallback' in video) {
          animId = video.requestVideoFrameCallback(drawLoop);
        } else {
          animId = requestAnimationFrame(drawLoop);
        }
      } catch (fatalErr) {
        reject(fatalErr);
      }
    });
  });

  const finalBlob = await compressionPromise;
  setProgress(100, '✓ Video compression complete!');
  addLogEntry(1, 'Video encoding complete', finalBlob.size, finalBlob.size <= targetBytes ? 'success' : 'pass');
  updateMetrics(finalBlob.size);
  document.getElementById('progressTimeRemaining').textContent = 'Done';
  state.iterations = 1;

  return finalBlob;
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
  const videoExts = ['mp4', 'webm', 'mov', 'm4v', 'mkv'];

  if (imageExts.includes(ext)) {
    ext = 'jpg';
  } else if (videoExts.includes(ext)) {
    ext = state.resultBlob.type && state.resultBlob.type.includes('mp4') ? 'mp4' : 'webm';
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
  revokePreviewVideoUrls();
  state.file        = null;
  state.fileBytes   = null;
  state.resultBlob  = null;
  state.targetBytes = 0;
  state.iterations  = 0;
  state.originalSize = 0;
  state.pptxContext = null;
  state.companionPdfDoc = null;
  state.pptxVideoPrefs = {};

  fileInput.value        = '';
  pptxPdfInput.value     = '';
  iterationLog.innerHTML = '';
  progressFill.style.width = '0%';

  pptxModal.classList.add('hidden');
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

