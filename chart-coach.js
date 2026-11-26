(() => {
  'use strict';

  const form = document.getElementById('coach-form');
  if (!form) return;

  const fileInput = document.getElementById('chart-file');
  const pairInput = document.getElementById('currency-pair');
  const timeframeInput = document.getElementById('chart-timeframe');
  const submitButton = document.getElementById('analyze-button');
  const clearButton = document.getElementById('clear-chart');
  const status = document.getElementById('coach-status');
  const errorBox = document.getElementById('coach-error');
  const previewSection = document.getElementById('preview-section');
  const previewImage = document.getElementById('chart-preview');
  const markerLayer = document.getElementById('annotation-layer');
  const results = document.getElementById('analysis-results');
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  const MAX_DATA_URL_CHARS = 3_700_000;
  const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
  let previewUrl = '';

  function setStatus(message, loading = false) {
    status.textContent = message;
    status.classList.toggle('is-loading', loading);
  }

  function clearRenderedResults() {
    results.hidden = true;
    errorBox.hidden = true;
    errorBox.textContent = '';
    markerLayer.replaceChildren();
    document.getElementById('annotation-list').replaceChildren();
    document.getElementById('caveat-list').replaceChildren();
  }

  function clearPreviewUrl() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    setStatus('The analysis did not complete. You can try again.');
  }

  function validateFile(file) {
    if (!file) return 'Choose a chart image first.';
    if (!ALLOWED_MIME.has(file.type)) return 'Use a PNG, JPG or WebP image.';
    if (file.size <= 0) return 'That image is empty. Choose another chart screenshot.';
    if (file.size > MAX_SOURCE_BYTES) return 'This image is larger than 12 MB. Choose a smaller screenshot.';
    return '';
  }

  async function compressImage(file) {
    const bitmap = await createImageBitmap(file);
    try {
      let edge = 1800;
      let quality = 0.88;
      let dataUrl = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image processing is not supported in this browser.');
        context.fillStyle = '#071426';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= MAX_DATA_URL_CHARS) return dataUrl;
        if (quality > 0.68) quality -= 0.08;
        else {
          edge = Math.round(edge * 0.82);
          quality = 0.82;
        }
      }
      if (dataUrl.length > MAX_DATA_URL_CHARS) {
        throw new Error('This screenshot could not be reduced enough to upload. Try a smaller or simpler image.');
      }
      return dataUrl;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function putText(id, value, fallback = 'Not clear enough to read from this image.') {
    const element = document.getElementById(id);
    element.textContent = typeof value === 'string' && value.trim() ? value : fallback;
  }

  function renderEvidenceSection(prefix, section) {
    putText(`${prefix}-reading`, section && section.reading);
    putText(`${prefix}-evidence`, section && section.evidence, 'No clear visual evidence was identified.');
    putText(`${prefix}-confidence`, section && section.confidence ? `Visual confidence: ${section.confidence}.` : 'Visual confidence: low.');
  }

  function renderConcept(prefix, concept) {
    const statusText = concept && concept.status === 'visible' ? 'Potentially visible' : 'Not clear in this image';
    putText(`${prefix}-status`, statusText);
    putText(`${prefix}-explanation`, concept && concept.explanation);
  }

  function renderBullets(containerId, values, fallback) {
    const list = document.getElementById(containerId);
    list.replaceChildren();
    const safeValues = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.trim()).slice(0, 6) : [];
    const items = safeValues.length ? safeValues : [fallback];
    for (const value of items) {
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    }
  }

  function renderAnnotations(annotations) {
    const markerValues = Array.isArray(annotations) ? annotations.filter((item) =>
      item && typeof item === 'object' && Number.isFinite(item.x) && Number.isFinite(item.y) &&
      item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1 &&
      typeof item.concept === 'string' && typeof item.label === 'string' && typeof item.explanation === 'string'
    ).slice(0, 8) : [];
    markerLayer.replaceChildren();
    const list = document.getElementById('annotation-list');
    list.replaceChildren();

    markerValues.forEach((annotation, index) => {
      const marker = document.createElement('span');
      marker.className = `annotation-marker annotation-${annotation.concept}`;
      marker.style.left = `${annotation.x * 100}%`;
      marker.style.top = `${annotation.y * 100}%`;
      marker.textContent = String(index + 1);
      markerLayer.appendChild(marker);

      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${annotation.concept.toUpperCase()} — ${annotation.label}. `;
      item.append(label, document.createTextNode(annotation.explanation));
      list.appendChild(item);
    });

    if (!markerValues.length) {
      const item = document.createElement('li');
      item.textContent = 'No reliable marker could be placed from this screenshot; the Coach has not guessed at a location.';
      list.appendChild(item);
    }
    putText('annotation-caption', markerValues.length
      ? 'Numbered markers are approximate AI-estimated teaching annotations, positioned from the screenshot—not measured or verified price levels.'
      : 'No markers were placed because the image did not support a reliable visual location.');
  }

  function renderAnalysis(data) {
    putText('bias-tag', `Visible read: ${data.observedBias || 'unclear'} (not a signal)`);
    putText('confidence-tag', `Overall visual confidence: ${data.overallConfidence || 'low'}`);
    putText('pair-timeframe-tag', `${pairInput.value} · ${timeframeInput.value}`);
    putText('analysis-summary-text', data.summary);

    renderEvidenceSection('structure', data.marketStructure);
    renderEvidenceSection('liquidity', data.liquidity);
    renderConcept('bos', data.bos);
    renderConcept('choch', data.choch);
    renderConcept('fvg', data.fairValueGap);

    putText('bullish-watch', data.bullishScenario && data.bullishScenario.conditionsToWatch);
    putText('bullish-weaken', data.bullishScenario && data.bullishScenario.whatWouldWeaken
      ? `This scenario would weaken if: ${data.bullishScenario.whatWouldWeaken}` : 'Treat as a conditional learning scenario, not a forecast.');
    putText('bearish-watch', data.bearishScenario && data.bearishScenario.conditionsToWatch);
    putText('bearish-weaken', data.bearishScenario && data.bearishScenario.whatWouldWeaken
      ? `This scenario would weaken if: ${data.bearishScenario.whatWouldWeaken}` : 'Treat as a conditional learning scenario, not a forecast.');
    renderBullets('caveat-list', data.caveats, 'The screenshot alone cannot confirm future price movement or unshown context.');
    renderAnnotations(data.annotations);
    results.hidden = false;
    setStatus('Analysis complete. Review each observation critically.');
  }

  fileInput.addEventListener('change', () => {
    clearRenderedResults();
    const file = fileInput.files && fileInput.files[0];
    const validationError = validateFile(file);
    if (validationError) {
      submitButton.disabled = true;
      previewSection.hidden = true;
      clearPreviewUrl();
      if (file) showError(validationError);
      else setStatus('Choose a chart image to begin.');
      return;
    }
    clearPreviewUrl();
    previewUrl = URL.createObjectURL(file);
    previewImage.src = previewUrl;
    previewImage.alt = `Uploaded ${pairInput.value} ${timeframeInput.value} chart preview`;
    previewSection.hidden = false;
    submitButton.disabled = false;
    setStatus('Image ready. Confirm the pair and timeframe, then analyze.');
  });

  for (const selector of [pairInput, timeframeInput]) {
    selector.addEventListener('change', () => {
      clearRenderedResults();
      if (fileInput.files && fileInput.files[0]) setStatus('Selection changed. Run the analysis again to update the reading.');
    });
  }

  clearButton.addEventListener('click', () => {
    form.reset();
    clearRenderedResults();
    clearPreviewUrl();
    previewImage.removeAttribute('src');
    previewSection.hidden = true;
    submitButton.disabled = true;
    setStatus('Choose a chart image to begin.');
    fileInput.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearRenderedResults();
    const file = fileInput.files && fileInput.files[0];
    const validationError = validateFile(file);
    if (validationError) {
      showError(validationError);
      return;
    }

    submitButton.disabled = true;
    clearButton.disabled = true;
    setStatus('Preparing your chart image…', true);
    const phases = [
      'Reading visible market structure…',
      'Checking liquidity, BOS/CHoCH and possible gaps…',
      'Building balanced educational scenarios…'
    ];
    let phase = 0;
    const phaseTimer = window.setInterval(() => {
      phase = (phase + 1) % phases.length;
      setStatus(phases[phase], true);
    }, 4500);

    try {
      const imageData = await compressImage(file);
      previewImage.src = imageData;
      previewImage.alt = `Uploaded ${pairInput.value} ${timeframeInput.value} chart preview`;
      setStatus('Sending the chart for visual analysis…', true);
      const response = await fetch('/api/chart-coach', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData, pair: pairInput.value, timeframe: timeframeInput.value })
      });
      let result;
      try { result = await response.json(); }
      catch (_) { throw new Error('The analysis service returned an unreadable response.'); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The analysis service could not complete the request.');
      renderAnalysis(result);
    } catch (error) {
      const message = error && typeof error.message === 'string' ? error.message : '';
      showError(message || 'The chart could not be analyzed. Check your connection and try again.');
    } finally {
      window.clearInterval(phaseTimer);
      submitButton.disabled = !(fileInput.files && fileInput.files[0]);
      clearButton.disabled = false;
    }
  });
})();
