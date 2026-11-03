/**
 * Listora Sparkle Remover — Client-Side Application Controller
 * Handles image IO, Canvas rendering, Before/After split comparison, and batch processing.
 */

(function () {
  'use strict';

  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const sampleBtn = document.getElementById('sampleBtn');
  const processingModal = document.getElementById('processingModal');
  const processingStep = document.getElementById('processingStep');
  const processingDetails = document.getElementById('processingDetails');

  const workspace = document.getElementById('workspace');
  const splitContainer = document.getElementById('splitContainer');
  const splitImgAfter = document.getElementById('splitImgAfter');
  const splitBeforeLayer = document.getElementById('splitBeforeLayer');
  const splitImgBefore = document.getElementById('splitImgBefore');
  const splitDivider = document.getElementById('splitDivider');

  const loupeBeforeCvs = document.getElementById('loupeBeforeCvs');
  const loupeAfterCvs = document.getElementById('loupeAfterCvs');
  const statSize = document.getElementById('statSize');
  const statCorner = document.getElementById('statCorner');
  const statScore = document.getElementById('statScore');
  const statTime = document.getElementById('statTime');
  const cleanStatusBadge = document.getElementById('cleanStatusBadge');

  const downloadPngBtn = document.getElementById('downloadPngBtn');
  const downloadJpgBtn = document.getElementById('downloadJpgBtn');
  const resetBtn = document.getElementById('resetBtn');

  // Mobile Sticky Dock & Tech Tabs
  const mobileActionDock = document.getElementById('mobileActionDock');
  const mobileDownloadPngBtn = document.getElementById('mobileDownloadPngBtn');
  const mobileResetBtn = document.getElementById('mobileResetBtn');
  const tabBtnPillars = document.getElementById('tabBtnPillars');
  const tabBtnBenchmark = document.getElementById('tabBtnBenchmark');
  const panelPillars = document.getElementById('panelPillars');
  const panelBenchmark = document.getElementById('panelBenchmark');

  const batchSection = document.getElementById('batchSection');
  const batchList = document.getElementById('batchList');
  const batchCount = document.getElementById('batchCount');

  // Application State
  let currentOriginalCanvas = null;
  let currentCleanedCanvas = null;
  let currentFileName = 'image';
  let isDraggingSlider = false;
  let sliderPercent = 50;
  let batchQueue = [];
  let isEngineReady = false;

  // ── Template Asset Pre-loading ──────────────────────────────────────────
  async function loadTemplateImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (!img.width || !img.height) {
          resolve(null);
          return;
        }
        const cvs = document.createElement('canvas');
        cvs.width = img.width;
        cvs.height = img.height;
        const ctx = cvs.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;
        resolve(data);
      };
      img.onerror = () => {
        console.warn(`Could not load template from ${url}, fallback to procedural`);
        resolve(null);
      };
      img.src = url;
    });
  }

  async function initEngine() {
    try {
      const [tpl48, tpl96, tpl96Alt] = await Promise.all([
        loadTemplateImage('assets/wm/gemini_bg_48.png'),
        loadTemplateImage('assets/wm/gemini_bg_96.png'),
        loadTemplateImage('assets/wm/gemini_bg_96_alt.png'),
      ]);
      SmartWatermarkCleaner.init(tpl48, tpl96, tpl96Alt);
      isEngineReady = true;
      console.log('SmartWatermarkCleaner initialized with production templates');
    } catch (err) {
      console.error('Engine init error:', err);
      SmartWatermarkCleaner.init(); // procedural fallback
      isEngineReady = true;
    }
  }

  initEngine();

  // ── Split Comparison Slider Controls ────────────────────────────────────
  function setSliderPosition(percent) {
    sliderPercent = Math.max(0, Math.min(100, percent));
    splitDivider.style.left = `${sliderPercent}%`;
    splitBeforeLayer.style.clipPath = `inset(0 ${100 - sliderPercent}% 0 0)`;
  }

  function handleSliderMove(clientX) {
    if (typeof clientX !== 'number' || isNaN(clientX)) return;
    const rect = splitContainer.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const x = clientX - rect.left;
    const pct = (x / rect.width) * 100;
    setSliderPosition(pct);
  }

  let dragMoved = false;

  splitDivider.addEventListener('mousedown', (e) => {
    isDraggingSlider = true;
    dragMoved = false;
    splitDivider.style.transition = 'none';
    splitBeforeLayer.style.transition = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (isDraggingSlider) {
      dragMoved = true;
      handleSliderMove(e.clientX);
    }
  });

  window.addEventListener('mouseup', () => {
    isDraggingSlider = false;
    setTimeout(() => { dragMoved = false; }, 50);
  });

  // Mobile Touch Support with Hitbox
  splitDivider.addEventListener('touchstart', (e) => {
    isDraggingSlider = true;
    dragMoved = false;
    splitDivider.style.transition = 'none';
    splitBeforeLayer.style.transition = 'none';
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isDraggingSlider && e.touches.length > 0) {
      dragMoved = true;
      handleSliderMove(e.touches[0].clientX);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDraggingSlider = false;
    setTimeout(() => { dragMoved = false; }, 50);
  });

  window.addEventListener('touchcancel', () => {
    isDraggingSlider = false;
    dragMoved = false;
  });

  // Smooth Tap-to-Compare anywhere on splitContainer
  splitContainer.addEventListener('click', (e) => {
    if (dragMoved) {
      dragMoved = false;
      return;
    }
    const rect = splitContainer.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;

    // Enable smooth animation for intentional tap-jumps
    splitDivider.style.transition = 'left 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    splitBeforeLayer.style.transition = 'clip-path 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    setSliderPosition(pct);
  });

  // ── Drag & Drop & Paste Event Listeners ───────────────────────────────────
  ['dragenter', 'dragover'].forEach((name) => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) handleFiles(files);
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target !== sampleBtn && !sampleBtn.contains(e.target)) {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) handleFiles(files);
    fileInput.value = '';
  });

  // Global Paste (Ctrl+V)
  window.addEventListener('paste', (e) => {
    const clipboardData = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
    if (!clipboardData || !clipboardData.items) return;
    const items = clipboardData.items;
    const imageFiles = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) imageFiles.push(blob);
      }
    }
    if (imageFiles.length > 0) handleFiles(imageFiles);
  });

  // ── File Ingestion Handler ──────────────────────────────────────────────
  function handleFiles(files) {
    if (files.length === 1) {
      processSingleFile(files[0]);
    } else if (files.length > 1) {
      processBatchFiles(files);
    }
  }

  // ── Single Image Processing Pipeline ────────────────────────────────────
  async function processSingleFile(file) {
    currentFileName = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'image';
    showProcessing('Loading image...', 'Reading pixel buffers');

    try {
      const img = await readFileAsImage(file);
      await runCleaningPipeline(img);
    } catch (err) {
      alert('Error loading image: ' + err.message);
      hideProcessing();
    }
  }

  function readFileAsImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode image data'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function runCleaningPipeline(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || w <= 0 || h <= 0) {
      alert('Invalid or empty image dimensions.');
      hideProcessing();
      return;
    }

    // Create Original Canvas
    const origCvs = document.createElement('canvas');
    origCvs.width = w;
    origCvs.height = h;
    const origCtx = origCvs.getContext('2d');
    origCtx.drawImage(img, 0, 0);

    // Extract RGBA bytes
    const origImgData = origCtx.getImageData(0, 0, w, h);
    const rgba = origImgData.data;

    // Convert RGBA -> ARGB Uint32Array (Kotlin 1:1 format)
    const px = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const off = i * 4;
      const r = rgba[off];
      const g = rgba[off + 1];
      const b = rgba[off + 2];
      const a = rgba[off + 3];
      px[i] = (a << 24) | (r << 16) | (g << 8) | b;
    }

    showProcessing('Executing Dual-Channel Optical Unblending...', 'Dual Sobel gradient correlation and candidate suppression delta');

    // Yield to render frame before intensive computation
    await new Promise((r) => setTimeout(r, 40));

    const startTime = performance.now();
    const result = SmartWatermarkCleaner.clean(px, w, h);
    const duration = Math.round(performance.now() - startTime);

    // Create Cleaned Canvas
    const cleanCvs = document.createElement('canvas');
    cleanCvs.width = w;
    cleanCvs.height = h;
    const cleanCtx = cleanCvs.getContext('2d');
    const cleanImgData = cleanCtx.createImageData(w, h);
    const cleanRgba = cleanImgData.data;

    for (let i = 0; i < w * h; i++) {
      const off = i * 4;
      const p = px[i];
      cleanRgba[off] = (p >> 16) & 0xFF;     // R
      cleanRgba[off + 1] = (p >> 8) & 0xFF;  // G
      cleanRgba[off + 2] = p & 0xFF;         // B
      cleanRgba[off + 3] = (p >> 24) & 0xFF; // A
    }
    cleanCtx.putImageData(cleanImgData, 0, 0);

    currentOriginalCanvas = origCvs;
    currentCleanedCanvas = cleanCvs;

    displayResults(origCvs, cleanCvs, result, duration);
    hideProcessing();
  }

  // ── Render Results to Viewport ──────────────────────────────────────────
  function displayResults(origCvs, cleanCvs, result, durationMs) {
    splitImgBefore.src = origCvs.toDataURL('image/png');
    splitImgAfter.src = cleanCvs.toDataURL('image/png');

    setSliderPosition(50);

    // Update Stats
    statTime.textContent = `${durationMs} ms`;

    if (result && result.success && result.hit) {
      const hit = result.hit;
      const cornerNames = {
        br: 'Bottom Right',
        bl: 'Bottom Left',
        tr: 'Top Right',
        tl: 'Top Left'
      };
      statSize.textContent = `${hit.side} px`;
      statCorner.textContent = `${cornerNames[hit.corner] || hit.corner} (${hit.x}, ${hit.y})`;
      statScore.textContent = `${(hit.score * 100).toFixed(1)}% NCC`;
      cleanStatusBadge.textContent = '✨ Sparkle Erased Cleanly';
      cleanStatusBadge.style.color = '#34d399';
      cleanStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';

      renderLoupe(origCvs, cleanCvs, hit);
    } else {
      statSize.textContent = 'None';
      statCorner.textContent = 'Clean';
      statScore.textContent = 'N/A';
      cleanStatusBadge.textContent = 'Pristine (No Watermark)';
      cleanStatusBadge.style.color = '#38bdf8';
      cleanStatusBadge.style.borderColor = 'rgba(6, 182, 212, 0.4)';

      clearLoupe();
    }

    dropZone.style.display = 'none';
    workspace.classList.add('active');
    if (mobileActionDock) {
      mobileActionDock.classList.add('active');
    }
  }

  // ── Render Loupe Magnifier ──────────────────────────────────────────────
  function renderLoupe(origCvs, cleanCvs, hit) {
    const s = hit.side;
    const pad = Math.round(s * 0.2);
    const cropX = Math.max(0, hit.x - pad);
    const cropY = Math.max(0, hit.y - pad);
    const cropW = Math.min(origCvs.width - cropX, s + pad * 2);
    const cropH = Math.min(origCvs.height - cropY, s + pad * 2);

    loupeBeforeCvs.width = 160;
    loupeBeforeCvs.height = 160;
    loupeAfterCvs.width = 160;
    loupeAfterCvs.height = 160;

    const bCtx = loupeBeforeCvs.getContext('2d');
    bCtx.imageSmoothingEnabled = false;
    bCtx.drawImage(origCvs, cropX, cropY, cropW, cropH, 0, 0, 160, 160);

    const aCtx = loupeAfterCvs.getContext('2d');
    aCtx.imageSmoothingEnabled = false;
    aCtx.drawImage(cleanCvs, cropX, cropY, cropW, cropH, 0, 0, 160, 160);
  }

  function clearLoupe() {
    [loupeBeforeCvs, loupeAfterCvs].forEach((cvs) => {
      cvs.width = 160;
      cvs.height = 160;
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = '#0e131f';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No Watermark', 80, 85);
    });
  }

  // ── Batch Queue Processor ───────────────────────────────────────────────
  async function processBatchFiles(files) {
    batchQueue = files.slice();
    batchList.innerHTML = '';
    batchCount.textContent = `${files.length} images`;
    batchSection.classList.add('active');
    dropZone.style.display = 'none';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const itemEl = document.createElement('div');
      itemEl.className = 'batch-item';

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%;';
      nameSpan.textContent = file.name; // Safe against DOM XSS

      const statusSpan = document.createElement('span');
      statusSpan.className = 'batch-status';
      statusSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8rem;';
      statusSpan.textContent = 'Processing...';

      itemEl.appendChild(nameSpan);
      itemEl.appendChild(statusSpan);
      batchList.appendChild(itemEl);

      try {
        const img = await readFileAsImage(file);
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h || w <= 0 || h <= 0) {
          throw new Error('Invalid image dimensions');
        }

        const cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
        const ctx = cvs.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas context unavailable');
        }
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, w, h);
        const rgba = imgData.data;

        const px = new Uint32Array(w * h);
        for (let j = 0; j < w * h; j++) {
          const off = j * 4;
          px[j] = (rgba[off + 3] << 24) | (rgba[off] << 16) | (rgba[off + 1] << 8) | rgba[off + 2];
        }

        const res = SmartWatermarkCleaner.clean(px, w, h);

        for (let j = 0; j < w * h; j++) {
          const off = j * 4;
          const p = px[j];
          rgba[off] = (p >> 16) & 0xFF;
          rgba[off + 1] = (p >> 8) & 0xFF;
          rgba[off + 2] = p & 0xFF;
          rgba[off + 3] = (p >> 24) & 0xFF;
        }
        ctx.putImageData(imgData, 0, 0);

        const statusEl = itemEl.querySelector('.batch-status');
        const dlBtn = document.createElement('a');
        dlBtn.className = 'btn btn-secondary';
        dlBtn.style.padding = '4px 10px';
        dlBtn.style.fontSize = '0.78rem';
        dlBtn.style.marginLeft = '10px';
        dlBtn.textContent = 'Download';
        dlBtn.download = file.name.replace(/\.[^/.]+$/, '') + '-cleaned.png';
        dlBtn.href = cvs.toDataURL('image/png');

        statusEl.textContent = (res && res.success && res.hit) ? `Cleaned (${res.hit.side}px)` : 'Clean (No WM)';
        statusEl.style.color = (res && res.success) ? '#34d399' : '#38bdf8';
        statusEl.appendChild(dlBtn);
      } catch (e) {
        const statusEl = itemEl.querySelector('.batch-status');
        statusEl.textContent = 'Error';
        statusEl.style.color = '#ef4444';
      }
    }
  }

  // ── Sample Image Generator ──────────────────────────────────────────────
  sampleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    generateSampleImage();
  });

  function generateSampleImage() {
    showProcessing('Generating sample photo...', 'Synthesizing Gemini sparkle watermark');

    const w = 800;
    const h = 800;
    const cvs = document.createElement('canvas');
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');

    // Draw rich gradient backdrop
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1e1b4b');
    grad.addColorStop(0.5, '#312e81');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Decorative shapes
    ctx.fillStyle = 'rgba(236, 72, 153, 0.25)';
    ctx.beginPath();
    ctx.arc(250, 300, 180, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.beginPath();
    ctx.arc(550, 450, 220, 0, Math.PI * 2);
    ctx.fill();

    // Stamp official or procedural sparkle watermark in bottom-right (s=48, margin=48)
    const s = 48;
    const m = 48;
    const bx = w - m - s;
    const by = h - m - s;
    const tpl = SmartWatermarkCleaner.template(s);

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const a = tpl[y * s + x];
        if (a > 0.02) {
          const off = ((by + y) * w + (bx + x)) * 4;
          data[off] = Math.round(data[off] * (1 - a) + 255 * a);
          data[off + 1] = Math.round(data[off + 1] * (1 - a) + 255 * a);
          data[off + 2] = Math.round(data[off + 2] * (1 - a) + 255 * a);
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const sampleImg = new Image();
    sampleImg.onload = () => {
      runCleaningPipeline(sampleImg);
    };
    sampleImg.src = cvs.toDataURL('image/png');
  }

  // ── Download & Reset Handlers ──────────────────────────────────────────
  function triggerPngDownload() {
    if (!currentCleanedCanvas) return;
    const a = document.createElement('a');
    a.download = `${currentFileName}-cleaned.png`;
    a.href = currentCleanedCanvas.toDataURL('image/png');
    a.click();
  }

  downloadPngBtn.addEventListener('click', triggerPngDownload);
  if (mobileDownloadPngBtn) {
    mobileDownloadPngBtn.addEventListener('click', triggerPngDownload);
  }

  downloadJpgBtn.addEventListener('click', () => {
    if (!currentCleanedCanvas) return;
    const a = document.createElement('a');
    a.download = `${currentFileName}-cleaned.jpg`;
    a.href = currentCleanedCanvas.toDataURL('image/jpeg', 0.95);
    a.click();
  });

  function resetWorkspace() {
    workspace.classList.remove('active');
    if (mobileActionDock) {
      mobileActionDock.classList.remove('active');
    }
    batchSection.classList.remove('active');
    dropZone.style.display = 'block';
    currentOriginalCanvas = null;
    currentCleanedCanvas = null;
    splitImgBefore.src = '';
    splitImgAfter.src = '';
    batchList.innerHTML = '';
  }

  resetBtn.addEventListener('click', resetWorkspace);
  if (mobileResetBtn) {
    mobileResetBtn.addEventListener('click', resetWorkspace);
  }

  // ── Technical Section Tab Switching ──────────────────────────────────────
  if (tabBtnPillars && tabBtnBenchmark && panelPillars && panelBenchmark) {
    tabBtnPillars.addEventListener('click', () => {
      tabBtnPillars.classList.add('active');
      tabBtnPillars.setAttribute('aria-selected', 'true');
      tabBtnBenchmark.classList.remove('active');
      tabBtnBenchmark.setAttribute('aria-selected', 'false');
      panelPillars.classList.add('active');
      panelBenchmark.classList.remove('active');
    });

    tabBtnBenchmark.addEventListener('click', () => {
      tabBtnBenchmark.classList.add('active');
      tabBtnBenchmark.setAttribute('aria-selected', 'true');
      tabBtnPillars.classList.remove('active');
      tabBtnPillars.setAttribute('aria-selected', 'false');
      panelBenchmark.classList.add('active');
      panelPillars.classList.remove('active');
    });
  }

  // ── Processing Modal Helpers ───────────────────────────────────────────
  function showProcessing(step, details) {
    processingStep.textContent = step;
    processingDetails.textContent = details || '';
    processingModal.classList.add('active');
  }

  function hideProcessing() {
    processingModal.classList.remove('active');
  }

})();
