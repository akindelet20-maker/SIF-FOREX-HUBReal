import { ACADEMY_MODULES } from './academy-data.js';

const PROGRESS_KEY = 'sifForexAcademyProgress.v2';
const LEGACY_KEY = 'sifForexAcademyStartHere.v1';
const PASS_SCORE = 4;
const allLessons = ACADEMY_MODULES.flatMap((module) => module.lessons.map((lesson, index) => ({ ...lesson, module, moduleLessonNumber: index + 1 })));
const lessonById = new Map(allLessons.map((lesson) => [lesson.id, lesson]));
const totalLessons = allLessons.length;
const els = {
  grid: document.getElementById('module-grid'), search: document.getElementById('lesson-search'), noResults: document.getElementById('no-search-results'),
  overview: document.getElementById('course-overview'), dashboard: document.querySelector('.learner-dashboard'), history: document.getElementById('learning-history'), catalog: document.getElementById('module-catalog'),
  certificates: document.getElementById('certificates'), disclaimer: document.querySelector('.academy-disclaimer'), lessonView: document.getElementById('lesson-view'), lessonContent: document.getElementById('lesson-content'),
  syncBanner: document.getElementById('sync-banner'), saveStatus: document.getElementById('save-status'), saveStatusText: document.getElementById('save-status-text'),
  certificateArea: document.getElementById('certificate-print-area'),
};

function blankState() {
  return { version: 2, completed: [], bookmarks: [], quizAttempts: 0, history: [], lastLessonId: null, updatedAt: new Date().toISOString() };
}
function safeRead(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const validIds = new Set(allLessons.map((lesson) => lesson.id));
  const completed = Array.isArray(source.completed) ? [...new Set(source.completed.map(String).filter((id) => validIds.has(id)))] : [];
  const bookmarks = Array.isArray(source.bookmarks) ? [...new Set(source.bookmarks.map(String).filter((id) => validIds.has(id)))] : [];
  const history = Array.isArray(source.history) ? source.history.filter((event) => event && typeof event === 'object' && validIds.has(String(event.lessonId))).slice(0, 120) : [];
  return {
    version: 2, completed, bookmarks, quizAttempts: Math.max(0, Number(source.quizAttempts) || 0), history,
    lastLessonId: validIds.has(String(source.lastLessonId)) ? String(source.lastLessonId) : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString(),
  };
}
function loadState() {
  const existing = safeRead(PROGRESS_KEY);
  if (existing) return normalizeState(existing);
  const state = normalizeState(null);
  const old = safeRead(LEGACY_KEY);
  if (old && Array.isArray(old.completed)) {
    old.completed.map(String).filter((id) => ['1', '2', '3', '4'].includes(id)).forEach((id) => state.completed.push(`m1-l${id}`));
    if (state.completed.length) state.history.push({ type: 'migrated', lessonId: state.completed[state.completed.length - 1], at: new Date().toISOString() });
  }
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(state)); } catch { /* private browsing can block storage */ }
  return state;
}
let state = loadState();
let currentLesson = null;
let currentUser = null;
let supabase = null;
let remoteTableReady = false;
let remoteSyncBusy = false;
let remoteWriteTimer = null;
let syncBannerShown = false;
let activityIdCounter = 0;
const moduleDataCache = new Map();
let lessonLoadToken = 0;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function setSaveStatus(message, mode = '') {
  els.saveStatusText.textContent = message;
  els.saveStatus.classList.toggle('is-synced', mode === 'synced');
  els.saveStatus.classList.toggle('is-offline', mode === 'offline');
}
function showSyncNotice(message, error = false) {
  if (!els.syncBanner) return;
  els.syncBanner.textContent = message;
  els.syncBanner.classList.toggle('is-error', error);
  els.syncBanner.hidden = false;
  syncBannerShown = true;
}
function persistState(queueRemote = true) {
  state.version = 2;
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
    setSaveStatus(currentUser && remoteTableReady ? 'Saving to your account…' : 'Progress saves on this device');
  } catch {
    setSaveStatus('Device storage is unavailable', 'offline');
  }
  if (queueRemote && currentUser && remoteTableReady) {
    window.clearTimeout(remoteWriteTimer);
    remoteWriteTimer = window.setTimeout(() => syncProgressToAccount(), 250);
  }
}
function eventId(event) {
  return `${event.type}|${event.lessonId}|${event.at}|${event.score ?? ''}`;
}
function mergeStates(left, right) {
  const a = normalizeState(left);
  const b = normalizeState(right);
  const history = new Map();
  [...a.history, ...b.history].forEach((event) => history.set(eventId(event), event));
  const mergedHistory = [...history.values()].sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, 120);
  const aTime = Date.parse(a.updatedAt) || 0;
  const bTime = Date.parse(b.updatedAt) || 0;
  return {
    version: 2,
    completed: [...new Set([...a.completed, ...b.completed])],
    bookmarks: [...new Set([...a.bookmarks, ...b.bookmarks])],
    quizAttempts: Math.max(a.quizAttempts, b.quizAttempts),
    history: mergedHistory,
    lastLessonId: bTime > aTime ? (b.lastLessonId || a.lastLessonId) : (a.lastLessonId || b.lastLessonId),
    updatedAt: bTime > aTime ? b.updatedAt : a.updatedAt,
  };
}
async function syncProgressToAccount() {
  if (!supabase || !currentUser || !remoteTableReady || remoteSyncBusy) return;
  remoteSyncBusy = true;
  setSaveStatus('Saving to your account…');
  try {
    const { error } = await supabase.from('academy_progress').upsert({
      user_id: currentUser.id,
      progress: state,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
    setSaveStatus('Synced to your account', 'synced');
    if (!syncBannerShown) {
      showSyncNotice('Signed in: your Academy progress is syncing to your account. Guest learning remains open to everyone.');
    }
  } catch (error) {
    remoteTableReady = false;
    setSaveStatus('Saved on this device', 'offline');
    showSyncNotice('Progress is safely saved on this device. Account sync is not available yet; your lessons and SIF Question assessments remain open. You can keep learning while sync is set up.', true);
    console.warn('Academy account sync is unavailable; device progress remains active.', error?.message || '');
  } finally {
    remoteSyncBusy = false;
  }
}
async function initializeAccountSync() {
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const client = createClient('https://kfaqrjhwbmkawnxkcrld.supabase.co', 'sb_publishable_-kdg7Pmr_mWPPfnv83VTMA_n2hhKXhk');
    supabase = client;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    currentUser = data?.session?.user || null;
    if (!currentUser) return;
    const { data: remoteRow, error: readError } = await client
      .from('academy_progress').select('progress,updated_at').eq('user_id', currentUser.id).maybeSingle();
    if (readError) throw readError;
    remoteTableReady = true;
    if (remoteRow?.progress) {
      state = mergeStates(state, remoteRow.progress);
      persistState(false);
    }
    await syncProgressToAccount();
    renderDashboard();
    renderCourse();
    const routeId = new URLSearchParams(window.location.search).get('lesson');
    if (routeId) openLesson(routeId, false);
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user && session.user.id !== currentUser?.id) {
        currentUser = session.user;
        initializeAccountSync();
      }
      if (event === 'SIGNED_OUT') {
        currentUser = null;
        remoteTableReady = false;
        setSaveStatus('Progress saves on this device');
      }
    });
  } catch (error) {
    if (currentUser) {
      setSaveStatus('Saved on this device', 'offline');
      showSyncNotice('Your lessons and progress remain available. Account sync could not connect, so progress is being kept on this device for now.', true);
    }
    console.info('Academy is running in guest/device-save mode.', error?.message || '');
  }
}

function completedCount() { return state.completed.length; }
function isComplete(lessonId) { return state.completed.includes(lessonId); }
function firstIncomplete() { return allLessons.find((lesson) => !isComplete(lesson.id)) || allLessons[allLessons.length - 1]; }
function isUnlocked(lessonId) {
  if (isComplete(lessonId)) return true;
  const index = allLessons.findIndex((lesson) => lesson.id === lessonId);
  if (index <= 0) return index === 0;
  return allLessons.slice(0, index).every((lesson) => isComplete(lesson.id));
}
function currentJourneyLesson() {
  if (state.lastLessonId && lessonById.has(state.lastLessonId) && !isComplete(state.lastLessonId) && isUnlocked(state.lastLessonId)) return lessonById.get(state.lastLessonId);
  return firstIncomplete();
}
function moduleCompletion(module) { return module.lessons.filter((lesson) => isComplete(lesson.id)).length; }
function moduleIsComplete(module) { return module.lessons.every((lesson) => isComplete(lesson.id)); }

function renderDashboard() {
  const done = completedCount();
  const percent = totalLessons ? Math.round((done / totalLessons) * 100) : 0;
  const completeModules = ACADEMY_MODULES.filter(moduleIsComplete).length;
  const progressText = `${done} of ${totalLessons} lessons complete`;
  document.getElementById('course-progress-number').textContent = `${percent}%`;
  document.getElementById('course-progress-ring').style.background = `conic-gradient(var(--academy-green) ${percent * 3.6}deg,rgba(193,214,206,.12) ${percent * 3.6}deg)`;
  document.getElementById('course-progress-ring').setAttribute('aria-label', `${percent} percent course progress`);
  document.getElementById('course-progress-bar').style.width = `${percent}%`;
  document.getElementById('course-progress-count').textContent = progressText;
  document.getElementById('course-module-count').textContent = `${completeModules} of ${ACADEMY_MODULES.length} modules`;
  document.getElementById('metric-lessons').textContent = String(done);
  document.getElementById('metric-quizzes').textContent = String(state.quizAttempts);
  const latest = state.history.find((item) => item.at);
  document.getElementById('metric-streak').textContent = latest ? relativeDate(latest.at) : '—';
  const next = currentJourneyLesson();
  const title = document.getElementById('continue-title');
  const desc = document.getElementById('continue-description');
  const link = document.getElementById('continue-link');
  const heroContinue = document.getElementById('hero-continue');
  if (next && done < totalLessons) {
    title.textContent = isComplete(next.id) ? 'Review your final lesson' : next.title;
    desc.textContent = `${next.module.title} · Lesson ${next.moduleLessonNumber} of ${next.module.lessons.length}. Your next SIF Question assessment is waiting.`;
    link.href = `academy.html?lesson=${encodeURIComponent(next.id)}`;
    link.innerHTML = `Continue with ${esc(next.title)} <span aria-hidden="true">→</span>`;
    heroContinue.hidden = false;
    heroContinue.onclick = () => navigateToLesson(next.id);
  } else {
    title.textContent = 'Your course journey is complete';
    desc.textContent = 'All 18 modules and lesson checks are complete. You can review any lesson or print your course certificate.';
    link.href = '#certificates';
    link.innerHTML = 'View your certificates <span aria-hidden="true">→</span>';
    heroContinue.hidden = false;
    heroContinue.textContent = 'View certificates ↗';
    heroContinue.onclick = () => document.getElementById('certificates').scrollIntoView({ behavior: 'smooth' });
  }
  renderHistory();
  renderCertificates();
}
function relativeDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'Recently';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const events = state.history.slice(0, 8);
  list.innerHTML = events.map((event) => {
    const lesson = lessonById.get(event.lessonId);
    if (!lesson) return '';
    let label = event.type === 'quiz' ? `SIF Question attempt · ${lesson.title}${Number.isFinite(event.score) ? ` · ${event.score}/5` : ''}`
      : event.type === 'complete' ? `Lesson completed · ${lesson.title}`
      : event.type === 'migrated' ? `Previous progress carried forward · ${lesson.module.title}`
      : `Lesson opened · ${lesson.title}`;
    return `<li><span>${esc(label)}</span><time datetime="${esc(event.at || '')}">${esc(relativeDate(event.at))}</time></li>`;
  }).join('');
  empty.hidden = events.length > 0;
  list.hidden = !(events.length > 0 && document.getElementById('history-toggle').getAttribute('aria-expanded') === 'true');
}
function renderCertificates() {
  const target = document.getElementById('certificate-actions');
  const complete = ACADEMY_MODULES.filter(moduleIsComplete);
  const allDone = complete.length === ACADEMY_MODULES.length;
  let markup = allDone ? '<button class="certificate-action" type="button" data-certificate="all">Print full Academy certificate</button>' : '';
  markup += complete.slice(0, 6).map((module) => `<button class="certificate-action" type="button" data-certificate="${module.id}">Module ${String(module.id).padStart(2, '0')} certificate</button>`).join('');
  if (complete.length > 6) markup += `<button class="certificate-action" type="button" data-certificate-list="more">+${complete.length - 6} more</button>`;
  target.innerHTML = markup || '<span class="certificate-note">Complete a module to unlock its certificate.</span>';
}

function renderCourse() {
  const query = (els.search.value || '').trim().toLowerCase();
  const active = currentJourneyLesson();
  const activeModuleId = active?.module.id;
  const cards = ACADEMY_MODULES.map((module) => {
    const matchedLessons = module.lessons.filter((lesson) => lesson.title.toLowerCase().includes(query));
    const moduleMatches = !query || module.title.toLowerCase().includes(query) || module.description.toLowerCase().includes(query);
    const hasMatch = moduleMatches || matchedLessons.length > 0;
    const done = moduleCompletion(module);
    const complete = moduleIsComplete(module);
    const first = module.lessons[0];
    const firstAvailable = isUnlocked(first.id);
    const statusText = complete ? 'COMPLETED' : (module.id === activeModuleId ? 'CONTINUE HERE' : firstAvailable ? 'AVAILABLE' : 'LOCKED');
    const statusClass = complete ? 'is-done' : (module.id === activeModuleId ? 'is-current' : '');
    const open = query ? hasMatch : module.id === activeModuleId;
    const lessonRows = module.lessons.map((lesson, index) => {
      const showRow = !query || moduleMatches || matchedLessons.includes(lesson);
      const completed = isComplete(lesson.id);
      const unlocked = isUnlocked(lesson.id);
      const isCurrent = active?.id === lesson.id;
      const stateClass = completed ? 'is-complete' : isCurrent ? 'is-current' : unlocked ? '' : 'is-locked';
      const icon = completed ? '✓' : isCurrent ? '•' : unlocked ? String(index + 1) : '⌑';
      const meta = completed ? 'DONE' : isCurrent ? 'NOW' : unlocked ? 'OPEN' : 'LOCKED';
      const safeTitle = esc(lesson.title);
      if (unlocked) return `<a class="module-lesson-row ${stateClass}" data-open-lesson="${esc(lesson.id)}" href="academy.html?lesson=${encodeURIComponent(lesson.id)}" ${showRow ? '' : 'hidden'}><span class="lesson-state-icon" aria-hidden="true">${icon}</span><span class="module-lesson-title">${safeTitle}</span><span class="module-lesson-meta">${meta}</span></a>`;
      const required = firstIncomplete();
      return `<button class="module-lesson-row ${stateClass}" type="button" disabled aria-disabled="true" title="Complete ${esc(required?.title || 'the previous lesson')} first" ${showRow ? '' : 'hidden'}><span class="lesson-state-icon" aria-hidden="true">${icon}</span><span class="module-lesson-title">${safeTitle}</span><span class="module-lesson-meta">${meta}</span></button>`;
    }).join('');
    return `<details class="module-card ${module.id === activeModuleId ? 'is-active-module' : ''} ${complete ? 'is-complete-module' : ''}" id="module-${module.id}" data-module="${module.id}" ${open ? 'open' : ''} ${hasMatch ? '' : 'hidden'}>
      <summary class="module-head"><span class="module-number">${String(module.id).padStart(2, '0')}</span><span class="module-title-block"><h3>${esc(module.title)}</h3><p>${esc(module.description)} · ${module.lessons.length} lessons</p></span><span class="module-status ${statusClass}">${statusText}</span></summary>
      <div class="module-progress-line"><span class="module-progress-track"><span style="width:${Math.round((done / module.lessons.length) * 100)}%"></span></span><span class="module-progress-label">${done}/${module.lessons.length} lessons</span></div>
      <div class="module-lesson-list">${lessonRows}</div>
    </details>`;
  }).join('');
  els.grid.innerHTML = cards;
  const visible = ACADEMY_MODULES.some((module) => {
    const card = document.getElementById(`module-${module.id}`);
    return card && !card.hidden;
  });
  els.noResults.hidden = !query || visible;
}

function addHistory(type, lesson, extra = {}) {
  const now = new Date().toISOString();
  const event = { type, lessonId: lesson.id, at: now, ...extra, _key: `${Date.now()}-${activityIdCounter++}` };
  const mostRecent = state.history.find((item) => item.lessonId === lesson.id && item.type === type);
  if (type === 'started' && mostRecent && (Date.now() - Date.parse(mostRecent.at || 0)) < 6 * 60 * 60 * 1000) return;
  state.history.unshift(event);
  state.history = state.history.slice(0, 120);
}
function setLessonMode(active) {
  document.body.classList.toggle('is-lesson-mode', active);
  els.lessonView.hidden = !active;
  if (active) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function navigateToLesson(lessonId) {
  const url = new URL('academy.html', window.location.href);
  url.searchParams.set('lesson', lessonId);
  window.history.pushState({ lessonId }, '', url);
  openLesson(lessonId, true);
}
function navigateToOverview() {
  lessonLoadToken += 1;
  const url = new URL('academy.html', window.location.href);
  url.search = '';
  window.history.pushState({ overview: true }, '', url);
  setLessonMode(false);
  currentLesson = null;
  renderDashboard();
  renderCourse();
  document.getElementById('module-catalog').scrollIntoView({ behavior: 'smooth' });
}
function renderLessonSidebar(lesson) {
  const segments = [
    ['objectives', 'Learning objectives'], ['concept', 'Understand the concept'], ['steps', 'How to work through it'],
    ['example', 'Practical example'], ['visual', 'Chart illustration'], ['remember', 'Key takeaways'],
    ['mistakes', 'Common mistakes'], ['summary', 'Lesson summary'], ['assessment', 'SIF Question assessment'],
  ];
  document.getElementById('lesson-outline').innerHTML = segments.map(([id, label]) => `<li><a href="#${id}">${esc(label)}</a></li>`).join('');
  const count = moduleCompletion(lesson.module);
  document.getElementById('module-progress-bar').style.width = `${Math.round((count / lesson.module.lessons.length) * 100)}%`;
  document.getElementById('module-progress-text').textContent = `${count} of ${lesson.module.lessons.length} lessons complete`;
  document.getElementById('module-overview-link').href = `academy.html#module-${lesson.module.id}`;
}
function updateLessonNavigation(lesson) {
  const index = allLessons.findIndex((item) => item.id === lesson.id);
  const previous = allLessons[index - 1];
  const next = allLessons[index + 1];
  const previousEl = document.getElementById('previous-lesson');
  const nextEl = document.getElementById('next-lesson');
  if (previous) {
    previousEl.hidden = false;
    previousEl.href = `academy.html?lesson=${encodeURIComponent(previous.id)}`;
    previousEl.dataset.openLesson = previous.id;
    document.getElementById('previous-title').textContent = previous.title;
  } else previousEl.hidden = true;
  if (next) {
    nextEl.hidden = false;
    document.getElementById('next-title').textContent = next.title;
    if (isUnlocked(next.id)) {
      nextEl.href = `academy.html?lesson=${encodeURIComponent(next.id)}`;
      nextEl.dataset.openLesson = next.id;
      nextEl.removeAttribute('aria-disabled');
      nextEl.classList.remove('is-locked');
      nextEl.querySelector('span').textContent = 'NEXT LESSON →';
    } else {
      nextEl.href = '#assessment';
      nextEl.removeAttribute('data-open-lesson');
      nextEl.setAttribute('aria-disabled', 'true');
      nextEl.classList.add('is-locked');
      nextEl.querySelector('span').textContent = 'NEXT LESSON · PASS SIF QUESTION TO UNLOCK';
    }
  } else nextEl.hidden = true;
}
async function openLesson(lessonId, recordStart = true) {
  const lessonSummary = lessonById.get(lessonId);
  let lesson = lessonSummary;
  if (!lesson) {
    showSyncNotice('We could not find that lesson. Your course progress is safe; choose a lesson from the module list.', true);
    setLessonMode(false);
    return;
  }
  currentLesson = lesson;
  setLessonMode(true);
  document.getElementById('lesson-breadcrumb').innerHTML = `<a href="academy.html" data-back-course="true">Academy</a> / <span>Module ${String(lesson.module.id).padStart(2, '0')}: ${esc(lesson.module.title)}</span>`;
  document.getElementById('lesson-bookmark').setAttribute('aria-pressed', String(state.bookmarks.includes(lesson.id)));
  document.querySelector('#lesson-bookmark span').textContent = state.bookmarks.includes(lesson.id) ? 'Saved lesson' : 'Save lesson';
  if (!isUnlocked(lesson.id)) {
    const required = firstIncomplete();
    const requiredLink = required ? `academy.html?lesson=${encodeURIComponent(required.id)}` : '#module-catalog';
    els.lessonContent.innerHTML = `<div class="lesson-locked-notice"><span class="academy-section-kicker">LESSON LOCKED · KEEP YOUR PLACE</span><h1 class="lesson-title">${esc(lesson.title)}</h1><p>This lesson is part of <strong>${esc(lesson.module.title)}</strong>. To keep the learning path in order, finish the earlier lesson and pass its five-question SIF Question assessment first. No account is required.</p><p>Your next step: <a href="${requiredLink}" data-open-lesson="${esc(required?.id || '')}">${esc(required?.title || 'Return to the curriculum')}</a>.</p></div>`;
    renderLessonSidebar(lesson);
    updateLessonNavigation(lesson);
    return;
  }
  const requestToken = ++lessonLoadToken;
  try {
    let moduleData = moduleDataCache.get(lesson.module.id);
    if (!moduleData) {
      const response = await fetch(`academy-content/module-${String(lesson.module.id).padStart(2, '0')}.json`, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Module content request failed (${response.status})`);
      moduleData = await response.json();
      moduleDataCache.set(lesson.module.id, moduleData);
    }
    const fullLesson = moduleData.lessons.find((item) => item.id === lessonSummary.id);
    if (!fullLesson) throw new Error('Lesson record is missing from its module file');
    lesson = { ...fullLesson, module: lessonSummary.module, moduleLessonNumber: lessonSummary.moduleLessonNumber };
  } catch (error) {
    if (requestToken !== lessonLoadToken) return;
    els.lessonContent.innerHTML = `<div class="lesson-locked-notice"><span class="academy-section-kicker">LESSON CONTENT NOT AVAILABLE</span><h1 class="lesson-title">${esc(lessonSummary.title)}</h1><p>This lesson did not load. Your saved progress is unchanged. Check your connection and reload the page, or return to the course overview.</p><p><a href="academy.html" data-back-course="true">Return to all modules</a></p></div>`;
    showSyncNotice('A lesson file could not be loaded. Your progress remains saved; try again when your connection is available.', true);
    console.warn('Academy lesson content could not be loaded.', error?.message || '');
    return;
  }
  if (requestToken !== lessonLoadToken) return;
  currentLesson = lesson;
  state.lastLessonId = lesson.id;
  if (recordStart) addHistory('started', lesson);
  persistState();
  const objectiveItems = (lesson.objectives || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const explanation = (lesson.explanation || []).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('');
  const steps = (lesson.steps || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const remember = (lesson.remember || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const mistakes = (lesson.mistakes || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const visual = renderVisual(lesson);
  const alreadyComplete = isComplete(lesson.id);
  els.lessonContent.innerHTML = `
    <header class="lesson-content-header"><span class="lesson-intro-label">MODULE ${String(lesson.module.id).padStart(2, '0')} · LESSON ${lesson.moduleLessonNumber} OF ${lesson.module.lessons.length}</span>
      <h1 class="lesson-title" id="lesson-title">${esc(lesson.title)}</h1>
      <p class="lesson-module-line"><span>${esc(lesson.module.title)}</span><span>About 5–8 minutes</span><span>${alreadyComplete ? 'Completed' : 'Knowledge check to complete'}</span></p>
      <p class="lesson-intro">${esc(lesson.intro)}</p>
    </header>
    <section class="lesson-section" id="objectives"><h3>By the end, you should be able to</h3><ul class="lesson-objectives">${objectiveItems}</ul></section>
    <section class="lesson-section lesson-explanation" id="concept"><h3>Understand the concept</h3>${explanation}</section>
    <section class="lesson-section" id="steps"><h3>Work through it step by step</h3><ol class="lesson-steps">${steps}</ol></section>
    <section class="lesson-section" id="example"><h3>Practical example</h3><div class="lesson-example"><strong>Illustrative example · not a trade suggestion</strong>${esc(lesson.example)}</div></section>
    <section class="lesson-section" id="visual"><h3>Chart illustration</h3>${visual}</section>
    <section class="lesson-section" id="remember"><h3>Key points to remember</h3><ul class="lesson-takeaways">${remember}</ul></section>
    <section class="lesson-section" id="mistakes"><h3>Common beginner mistakes</h3><ul class="lesson-mistakes">${mistakes}</ul></section>
    <section class="lesson-section" id="summary"><h3>Short lesson summary</h3><div class="lesson-summary">${esc(lesson.summary)}</div></section>
    <section class="lesson-assessment-link" id="assessment" aria-labelledby="assessment-title"><span class="academy-section-kicker">ASSESSMENT · SEPARATE SECTION</span><h3 id="assessment-title">Ready to check what you learned?</h3><p>Open <strong>SIF Question</strong> for this lesson’s five-question assessment. Score ${PASS_SCORE}/5 to mark the lesson complete and unlock the next step. ${alreadyComplete ? 'You have already passed this lesson and may retake the assessment.' : 'Your lesson progress stays saved while you take the assessment.'}</p><a class="assessment-link-button" href="sif-question.html?lesson=${encodeURIComponent(lesson.id)}">Take this lesson’s SIF Question →</a></section>`;
  if (recordStart) persistState();
  renderLessonSidebar(lesson);
  updateLessonNavigation(lesson);
  document.title = `${lesson.title} | Forex Academy | SIF FOREX HUB`;
  renderDashboard();
}

function svgShell(label, content, xLabels = '') {
  const grid = [54, 94, 134, 174].map((y) => `<path class="chart-grid" d="M48 ${y}H612"/>`).join('') + [160, 260, 360, 460, 560].map((x) => `<path class="chart-grid" d="M${x} 24V190"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220" role="img" aria-label="${esc(label)}"><defs><marker id="academy-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6" fill="none" stroke="#e2c77e" stroke-width="1.4"/></marker></defs>${grid}${content}<path d="M48 190H612" stroke="rgba(176,198,207,.35)" stroke-width="1"/>${xLabels}</svg>`;
}
function candle(x, high, low, open, close) {
  const top = Math.min(open, close);
  const height = Math.max(4, Math.abs(open - close));
  const cls = close < open ? 'chart-candle-down' : 'chart-candle-up';
  return `<line class="chart-wick" x1="${x}" y1="${high}" x2="${x}" y2="${low}"/><rect class="${cls}" x="${x - 9}" y="${top}" width="18" height="${height}" rx="2"/>`;
}
function patternChart(title) {
  const name = title.toLowerCase();
  let bars;
  let labels = '';
  if (name.includes('doji')) {
    bars = candle(190, 74, 145, 107, 108) + candle(320, 59, 160, 105, 106) + candle(450, 79, 151, 109, 108);
    labels = '<text class="chart-label" x="471" y="67">Small body</text><path class="chart-line-gold" d="M450 74H507"/>';
  } else if (name.includes('hammer') && !name.includes('inverted')) {
    bars = candle(190, 80, 149, 100, 111) + candle(320, 79, 176, 101, 112) + candle(450, 87, 154, 100, 113);
    labels = '<text class="chart-label" x="370" y="179">Long lower wick</text><path class="chart-line-gold" d="M426 171L446 147"/>';
  } else if (name.includes('inverted') || name.includes('shooting star') || name.includes('hanging')) {
    bars = candle(190, 71, 151, 101, 112) + candle(320, 34, 146, 107, 118) + candle(450, 73, 154, 101, 113);
    labels = '<text class="chart-label" x="367" y="32">Long upper wick</text><path class="chart-line-gold" d="M434 40L420 69"/>';
  } else if (name.includes('engulfing')) {
    const bull = name.includes('bullish');
    bars = candle(220, 76, 147, 90, 129) + candle(350, 58, 164, 136, 82) + candle(478, 62, 149, 92, 126);
    if (!bull) bars = candle(220, 61, 151, 130, 84) + candle(350, 49, 166, 80, 137) + candle(478, 64, 152, 127, 89);
    labels = `<text class="chart-label" x="389" y="34">${bull ? 'Bullish' : 'Bearish'} body wraps prior candle</text>`;
  } else if (name.includes('morning star') || name.includes('evening star')) {
    const morning = name.includes('morning');
    bars = morning ? candle(200, 57, 143, 65, 132) + candle(325, 104, 158, 127, 131) + candle(450, 71, 153, 133, 84)
      : candle(200, 70, 153, 130, 82) + candle(325, 50, 105, 88, 94) + candle(450, 51, 148, 88, 135);
    labels = `<text class="chart-label" x="208" y="178">1</text><text class="chart-label" x="321" y="178">2</text><text class="chart-label" x="447" y="178">3</text>`;
  } else if (name.includes('inside bar')) {
    bars = candle(210, 54, 158, 75, 137) + candle(335, 81, 127, 94, 112) + candle(460, 61, 153, 130, 87);
    labels = '<path class="chart-line-gold" d="M300 81H369M300 127H369"/><text class="chart-label" x="307" y="73">Inside range</text>';
  } else {
    bars = candle(180, 55, 156, 78, 135) + candle(310, 47, 160, 136, 78) + candle(440, 63, 166, 89, 140);
    labels = '<text class="chart-label" x="74" y="207">Illustrative candles</text>';
  }
  return svgShell(`${title} candlestick pattern schematic`, `${bars}<text class="chart-axis" x="55" y="20">Price path · illustration</text>${labels}`);
}
function renderVisual(lesson) {
  const type = lesson.module.id === 7 ? 'pattern' : String(lesson.visual?.type || 'candles').toLowerCase();
  const title = lesson.title;
  let svg;
  if (type === 'pattern') svg = patternChart(title);
  else if (type === 'trend') svg = svgShell('Illustrative trend and pullback', '<path class="chart-line" d="M60 158L127 126L174 143L246 99L297 118L369 72L418 91L484 50L558 63"/><path class="chart-line-gold" d="M60 173L558 173"/><text class="chart-label" x="491" y="41">Higher swing</text><text class="chart-axis" x="63" y="188">Time →</text>');
  else if (type === 'levels') svg = svgShell('Schematic support and resistance chart', '<path class="chart-zone" d="M49 57H611V77H49Z"/><path class="chart-zone-green" d="M49 151H611V171H49Z"/><path class="chart-line" d="M59 130L106 112L145 148L198 97L247 125L297 91L347 116L395 88L442 117L489 80L535 104L600 70"/><text class="chart-label" x="55" y="51">Resistance area · not a ceiling</text><text class="chart-label" x="55" y="187">Support area · not a floor</text>');
  else if (type === 'supplydemand') svg = svgShell('Schematic supply and demand zones with a failed revisit', `${candle(118,96,160,126,144)}${candle(223,84,150,140,102)}${candle(328,55,130,110,66)}${candle(433,52,135,69,113)}${candle(538,78,156,114,141)}<rect class="chart-zone" x="278" y="45" width="142" height="31" rx="5"/><rect class="chart-zone-green" x="92" y="142" width="152" height="31" rx="5"/><text class="chart-label" x="292" y="64">SUPPLY · inferred</text><text class="chart-label" x="105" y="161">DEMAND · inferred</text><text class="chart-axis" x="118" y="207">Candidate zones only · a revisit may fail</text>`);
  else if (type === 'structure') {
    const labels = title.toLowerCase().includes('down') || title.includes('LH') || title.includes('LL')
      ? '<text class="chart-label" x="148" y="87">LH</text><text class="chart-label" x="262" y="137">LL</text><text class="chart-label" x="380" y="111">LH</text><text class="chart-label" x="511" y="169">LL</text>'
      : '<text class="chart-label" x="148" y="73">HH</text><text class="chart-label" x="262" y="142">HL</text><text class="chart-label" x="380" y="45">HH</text><text class="chart-label" x="511" y="104">HL</text>';
    const extra = title.includes('BOS') || title.includes('CHoCH') || title.includes('MSS') ? '<path class="chart-line-gold" d="M345 96H550"/><text class="chart-label" x="460" y="88">Structure level</text>' : '';
    svg = svgShell('Schematic swing structure with higher or lower highs and lows', `<path class="chart-line" d="M62 151L153 80L214 128L286 67L347 108L412 43L478 94L555 59"/>${labels}${extra}<text class="chart-axis" x="64" y="207">Swing sequence · choose a timeframe</text>`);
  } else if (type === 'liquidity') svg = svgShell('Schematic liquidity sweep around a prior high', '<path class="chart-line-gold" d="M48 73H612"/><text class="chart-label" x="50" y="64">Prior swing high / possible liquidity area</text><path class="chart-line" d="M61 147L125 108L180 129L239 78L302 111L359 83L421 108L480 45L515 29L545 103L595 137"/><circle class="chart-marker" cx="515" cy="29" r="5"/><path d="M515 36V72" stroke="#e2c77e" stroke-dasharray="3 3"/><text class="chart-label" x="527" y="35">Wick through</text><text class="chart-axis" x="511" y="162">A sweep is an interpretation, not proof of intent</text>');
  else if (type === 'fvg') svg = svgShell('Three-candle fair value gap teaching schematic', `${candle(155,90,148,106,130)}${candle(315,30,170,152,58)}${candle(475,62,141,88,120)}<rect class="chart-zone" x="341" y="76" width="92" height="38" rx="4"/><path class="chart-line-gold" d="M337 76H443M337 114H443"/><text class="chart-label" x="352" y="99">Illustrative gap</text><text class="chart-axis" x="48" y="207">Three-candle pattern; definitions vary by trader</text>`);
  else if (type === 'orderblock') svg = svgShell('Schematic order block study zone', `${candle(140,92,159,106,142)}${candle(245,66,158,140,82)}${candle(350,38,168,151,61)}${candle(455,58,129,79,111)}<rect class="chart-zone-green" x="198" y="110" width="90" height="38" rx="4"/><text class="chart-label" x="205" y="133">Study zone</text><path class="chart-line" d="M480 146L521 88L561 105L598 52"/><text class="chart-axis" x="48" y="207">Zone selection is subjective; a revisit can fail</text>`);
  else if (type === 'risk') svg = svgShell('Illustrative risk and account-protection diagram', '<rect class="chart-zone-green" x="75" y="55" width="490" height="36" rx="7"/><rect class="chart-zone" x="75" y="103" width="320" height="36" rx="7"/><rect x="75" y="151" width="205" height="22" rx="5" fill="rgba(232,121,126,.12)" stroke="rgba(232,121,126,.35)"/><text class="chart-label" x="89" y="77">Define maximum acceptable loss before a decision</text><text class="chart-label" x="89" y="126">Position size is an input, not a promise</text><text class="chart-label" x="89" y="167">Stop orders may slip or gap</text><text class="chart-axis" x="75" y="199">Conceptual only · no suggested risk percentage</text>');
  else if (type === 'entry') svg = svgShell('Illustrative entry, take profit/exit and stop loss levels', `${candle(135,97,155,121,140)}${candle(230,79,166,144,95)}${candle(325,64,148,103,129)}${candle(420,45,143,126,74)}<path class="chart-line-gold" d="M48 79H612"/><path d="M48 112H612" stroke="#6fbca0" stroke-width="1.4" stroke-dasharray="4 4"/><path d="M48 155H612" stroke="#e8797e" stroke-width="1.4" stroke-dasharray="4 4"/><text class="chart-label" x="452" y="70">TAKE PROFIT / EXIT</text><text class="chart-label" x="522" y="105">ENTRY</text><text class="chart-label" x="527" y="149">STOP LOSS</text><text class="chart-axis" x="48" y="207">Illustrative levels · no guaranteed fills or outcomes</text>`);
  else if (type === 'session') svg = svgShell('Schematic global Forex session timeline', '<rect class="chart-zone" x="62" y="82" width="120" height="56" rx="8"/><rect class="chart-zone-green" x="196" y="82" width="120" height="56" rx="8"/><rect class="chart-zone" x="330" y="82" width="120" height="56" rx="8"/><rect class="chart-zone-green" x="464" y="82" width="120" height="56" rx="8"/><text class="chart-label" x="96" y="108">Sydney</text><text class="chart-label" x="232" y="108">Tokyo</text><text class="chart-label" x="365" y="108">London</text><text class="chart-label" x="500" y="108">New York</text><text class="chart-axis" x="66" y="130">WAT times shift seasonally with daylight saving in some regions</text><path class="chart-line-gold" d="M316 152H464"/><text class="chart-axis" x="339" y="168">Overlap · often busier</text>');
  else if (type === 'pairs') svg = svgShell('Base and quote currency pair diagram', '<rect class="chart-zone-green" x="78" y="70" width="185" height="80" rx="13"/><rect class="chart-zone" x="376" y="70" width="185" height="80" rx="13"/><text class="chart-axis" x="98" y="94">BASE CURRENCY</text><text class="chart-label" x="135" y="127">EUR</text><text class="chart-axis" x="396" y="94">QUOTE CURRENCY</text><text class="chart-label" x="436" y="127">USD</text><path d="M280 109H360" stroke="#e2c77e" stroke-width="2" marker-end="url(#academy-arrow)"/><text class="chart-axis" x="273" y="133">EUR/USD</text><text class="chart-axis" x="145" y="183">Pair price asks how many quote units equal one base unit</text>');
  else if (type === 'macro') svg = svgShell('Economic news and currency price schematic', '<path class="chart-line" d="M58 146L126 132L193 143L252 112L306 121L351 119L395 55L434 128L497 108L551 91L599 104"/><path d="M395 35V174" stroke="#e2c77e" stroke-dasharray="4 4"/><rect class="chart-zone" x="355" y="27" width="82" height="26" rx="5"/><text class="chart-label" x="366" y="44">News release</text><text class="chart-axis" x="58" y="190">Illustration: reaction can be fast, mixed, or already priced in</text>');
  else if (type === 'platform') svg = svgShell('Simplified trading platform interface diagram', '<rect x="58" y="40" width="382" height="136" rx="8" fill="rgba(13,31,43,.8)" stroke="rgba(169,192,205,.35)"/><path class="chart-grid" d="M70 74H425M70 106H425M70 138H425M146 52V165M226 52V165M306 52V165M386 52V165"/><path class="chart-line" d="M78 144L117 119L152 132L189 92L220 114L257 75L297 96L333 68L375 88L415 61"/><rect class="chart-zone-green" x="461" y="51" width="121" height="45" rx="7"/><rect class="chart-zone" x="461" y="108" width="121" height="45" rx="7"/><text class="chart-label" x="480" y="78">BUY · review</text><text class="chart-label" x="481" y="135">SELL · review</text><text class="chart-axis" x="73" y="190">Practice interface map · buttons vary by platform</text>');
  else if (type === 'psychology') svg = svgShell('Trading process and emotional decision diagram', '<rect class="chart-zone" x="52" y="80" width="126" height="54" rx="9"/><rect class="chart-zone-green" x="255" y="80" width="126" height="54" rx="9"/><rect class="chart-zone" x="458" y="80" width="126" height="54" rx="9"/><text class="chart-label" x="82" y="105">Written plan</text><text class="chart-axis" x="69" y="121">Before action</text><text class="chart-label" x="286" y="105">Pause & check</text><text class="chart-axis" x="279" y="121">During pressure</text><text class="chart-label" x="491" y="105">Record & review</text><text class="chart-axis" x="492" y="121">After action</text><path class="chart-arrow" d="M183 107H245"/><path class="chart-arrow" d="M386 107H448"/><text class="chart-axis" x="149" y="164">A repeatable process supports reflection; it cannot control outcomes</text>');
  else if (type === 'broker') svg = svgShell('Broker due diligence checklist schematic', '<rect class="chart-zone" x="77" y="47" width="220" height="126" rx="10"/><rect class="chart-zone-green" x="332" y="47" width="230" height="126" rx="10"/><text class="chart-label" x="98" y="73">Before choosing</text><text class="chart-axis" x="100" y="96">• Regulator and legal entity</text><text class="chart-axis" x="100" y="117">• Fees, spreads, withdrawal terms</text><text class="chart-axis" x="100" y="138">• Risk disclosures and support</text><text class="chart-label" x="354" y="73">Verify from original sources</text><text class="chart-axis" x="355" y="96">• Official register</text><text class="chart-axis" x="355" y="117">• Provider contract</text><text class="chart-axis" x="355" y="138">• Independent complaints</text>');
  else if (type === 'journal') svg = svgShell('Trading journal and performance tracking schematic', '<rect x="65" y="47" width="510" height="126" rx="8" fill="rgba(12,28,40,.7)" stroke="rgba(169,192,205,.3)"/><path class="chart-grid" d="M65 80H575M65 111H575M65 142H575M180 47V173M325 47V173M445 47V173"/><text class="chart-label" x="80" y="68">Date & pair</text><text class="chart-label" x="194" y="68">Plan / risk</text><text class="chart-label" x="340" y="68">Result</text><text class="chart-label" x="458" y="68">Review note</text><text class="chart-axis" x="80" y="101">Practice 01</text><text class="chart-axis" x="80" y="132">Practice 02</text><text class="chart-axis" x="80" y="162">Practice 03</text><text class="chart-axis" x="65" y="195">Example rows only · log process, not just profit or loss</text>');
  else if (type === 'propfirm') svg = svgShell('Prop-firm evaluation rules schematic', '<rect class="chart-zone" x="70" y="53" width="133" height="113" rx="9"/><rect class="chart-zone-green" x="253" y="53" width="133" height="113" rx="9"/><rect class="chart-zone" x="436" y="53" width="133" height="113" rx="9"/><text class="chart-label" x="100" y="80">Challenge rules</text><text class="chart-axis" x="94" y="103">Target</text><text class="chart-axis" x="94" y="122">Daily limit</text><text class="chart-axis" x="94" y="141">Overall limit</text><text class="chart-label" x="284" y="80">Evaluation</text><text class="chart-axis" x="282" y="107">Follow exact terms</text><text class="chart-axis" x="271" y="126">Track all drawdown</text><text class="chart-label" x="462" y="80">Review first</text><text class="chart-axis" x="460" y="107">Fees & payout terms</text><text class="chart-axis" x="460" y="126">Firm risk & rules</text><text class="chart-axis" x="460" y="145">Rules can change</text>');
  else if (type === 'routine') svg = svgShell('Daily market preparation and review routine schematic', '<rect class="chart-zone" x="55" y="79" width="110" height="56" rx="8"/><rect class="chart-zone-green" x="195" y="79" width="110" height="56" rx="8"/><rect class="chart-zone" x="335" y="79" width="110" height="56" rx="8"/><rect class="chart-zone-green" x="475" y="79" width="110" height="56" rx="8"/><text class="chart-label" x="78" y="103">Prepare</text><text class="chart-axis" x="70" y="120">Calendar & limits</text><text class="chart-label" x="219" y="103">Observe</text><text class="chart-axis" x="210" y="120">Wait for a setup</text><text class="chart-label" x="362" y="103">Record</text><text class="chart-axis" x="352" y="120">Follow written plan</text><text class="chart-label" x="497" y="103">Review</text><text class="chart-axis" x="490" y="120">Reflect & stop</text><path class="chart-arrow" d="M166 108H187"/><path class="chart-arrow" d="M306 108H327"/><path class="chart-arrow" d="M446 108H467"/>');
  else if (type === 'timeline') svg = svgShell('Historical or chronological learning timeline', '<path d="M75 111H565" stroke="#72b9a0" stroke-width="3"/><circle class="chart-marker" cx="100" cy="111" r="8"/><circle class="chart-marker" cx="250" cy="111" r="8"/><circle class="chart-marker" cx="400" cy="111" r="8"/><circle class="chart-marker" cx="550" cy="111" r="8"/><text class="chart-label" x="75" y="80">Then</text><text class="chart-label" x="218" y="80">Change</text><text class="chart-label" x="373" y="80">Today</text><text class="chart-label" x="512" y="80">Review</text><text class="chart-axis" x="111" y="143">Milestones help explain context, not predict price</text>');
  else svg = svgShell('Illustrative candlestick chart schematic', `${candle(118,78,151,102,126)}${candle(208,62,164,136,82)}${candle(298,54,146,98,127)}${candle(388,40,159,136,72)}${candle(478,61,157,88,129)}<text class="chart-axis" x="59" y="207">Price action illustration · not a live quote or signal</text>`);
  return `<figure class="lesson-visual"><figcaption><strong>Illustration · ${esc(lesson.visual?.caption || title)}</strong>Teaching schematic only—no live prices, forecast or trade signal.</figcaption>${svg}</figure>`;
}

function printCertificate(moduleId) {
  const module = moduleId === 'all' ? null : ACADEMY_MODULES.find((item) => item.id === Number(moduleId));
  if (module && !moduleIsComplete(module)) return;
  if (!module && completedCount() !== totalLessons) return;
  const name = currentUser?.user_metadata?.full_name || 'SIF Forex Hub Learner';
  const course = module ? `Module ${String(module.id).padStart(2, '0')}: ${module.title}` : 'Complete Forex Beginner Curriculum';
  const code = `SIF-${module ? String(module.id).padStart(2, '0') : 'COURSE'}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  els.certificateArea.innerHTML = `<div class="certificate-sheet"><div class="certificate-brand">SIF FOREX HUB · LEARN · TRADE · EARN</div><h2>Certificate of Learning</h2><p>This recognises that</p><div class="certificate-person">${esc(name)}</div><p>has completed the learning lessons and knowledge checks for</p><div class="certificate-course">${esc(course)}</div><p>This certificate recognises educational participation only. It is not a trading licence, professional qualification, endorsement, or evidence of trading performance.</p><div class="certificate-meta">Issued ${esc(date)} · Reference ${esc(code)}</div></div><div class="certificate-print-actions"><button type="button" data-print-certificate>Print / save as PDF</button><button type="button" data-close-certificate>Close</button></div>`;
  els.certificateArea.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeCertificate() {
  els.certificateArea.hidden = true;
  document.body.style.overflow = '';
}

els.grid.addEventListener('click', (event) => {
  const link = event.target.closest('[data-open-lesson]');
  if (!link || link.hasAttribute('disabled')) return;
  const id = link.dataset.openLesson;
  if (!lessonById.has(id)) return;
  event.preventDefault();
  navigateToLesson(id);
});
els.lessonContent.addEventListener('click', (event) => {
  const link = event.target.closest('[data-open-lesson]');
  if (!link || !link.dataset.openLesson || !lessonById.has(link.dataset.openLesson)) return;
  event.preventDefault();
  navigateToLesson(link.dataset.openLesson);
});
document.getElementById('back-to-course').addEventListener('click', navigateToOverview);
document.getElementById('lesson-bookmark').addEventListener('click', () => {
  if (!currentLesson || !isUnlocked(currentLesson.id)) return;
  const index = state.bookmarks.indexOf(currentLesson.id);
  if (index >= 0) state.bookmarks.splice(index, 1); else state.bookmarks.push(currentLesson.id);
  persistState();
  const button = document.getElementById('lesson-bookmark');
  const saved = state.bookmarks.includes(currentLesson.id);
  button.setAttribute('aria-pressed', String(saved));
  button.querySelector('span').textContent = saved ? 'Saved lesson' : 'Save lesson';
});
document.getElementById('previous-lesson').addEventListener('click', (event) => {
  const id = event.currentTarget.dataset.openLesson;
  if (id) { event.preventDefault(); navigateToLesson(id); }
});
document.getElementById('next-lesson').addEventListener('click', (event) => {
  const id = event.currentTarget.dataset.openLesson;
  if (id) { event.preventDefault(); navigateToLesson(id); }
      else if (event.currentTarget.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        const assessment = document.getElementById('assessment') || document.getElementById('module-catalog');
        assessment?.scrollIntoView({ behavior: 'smooth' });
      }
});
document.getElementById('lesson-breadcrumb').addEventListener('click', (event) => {
  if (event.target.closest('[data-back-course]')) { event.preventDefault(); navigateToOverview(); }
});
els.search.addEventListener('input', renderCourse);
document.getElementById('history-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  button.textContent = expanded ? 'Show history' : 'Hide history';
  renderHistory();
});
document.getElementById('certificate-actions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-certificate]');
  if (button) printCertificate(button.dataset.certificate);
  const more = event.target.closest('[data-certificate-list]');
  if (more) {
    const target = document.getElementById('certificate-actions');
    target.innerHTML += ACADEMY_MODULES.filter(moduleIsComplete).slice(6).map((module) => `<button class="certificate-action" type="button" data-certificate="${module.id}">Module ${String(module.id).padStart(2, '0')} certificate</button>`).join('');
    more.remove();
  }
});
els.certificateArea.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-certificate]')) closeCertificate();
  if (event.target.closest('[data-print-certificate]')) window.print();
  if (event.target === els.certificateArea) closeCertificate();
});
window.addEventListener('afterprint', closeCertificate);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !els.certificateArea.hidden) closeCertificate(); });
window.addEventListener('popstate', () => {
  const routeId = new URLSearchParams(window.location.search).get('lesson');
  if (routeId) openLesson(routeId, false);
  else { lessonLoadToken += 1; setLessonMode(false); currentLesson = null; renderDashboard(); renderCourse(); }
});
window.addEventListener('pageshow', () => {
  state = mergeStates(state, loadState());
  renderDashboard();
  renderCourse();
  if (currentLesson) { renderLessonSidebar(currentLesson); updateLessonNavigation(currentLesson); }
});

function makeHeroChart() {
  const host = document.getElementById('hero-chart');
  const bars = [
    [74,115,151,125,143],[130,92,154,139,107],[186,102,143,110,130],[242,72,145,130,87],
    [298,83,152,96,127],[354,58,138,124,79],[410,68,148,85,119],[466,40,131,116,66],
    [522,54,135,75,104],[578,34,118,102,55],
  ];
  const marks = bars.map(([x, high, low, open, close]) => candle(x, high, low, open, close)).join('');
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 190" role="img" aria-label="Illustrative candlestick chart showing a varied price path, not market data"><path d="M38 26V162H612" fill="none" stroke="rgba(165,190,199,.22)"/><path d="M38 56H612M38 91H612M38 126H612" fill="none" stroke="rgba(165,190,199,.11)"/><path d="M115 26V162M225 26V162M335 26V162M445 26V162M555 26V162" fill="none" stroke="rgba(165,190,199,.08)"/>${marks}<path d="M39 174H612" stroke="rgba(169,192,205,.25)"/><text x="40" y="14" fill="#89a0a6" font-size="8" font-family="DM Sans">PRICE ACTION · ILLUSTRATION ONLY</text></svg>`;
}

function init() {
  makeHeroChart();
  renderDashboard();
  renderCourse();
  const params = new URLSearchParams(window.location.search);
  const routeId = params.get('lesson');
  if (routeId) openLesson(routeId, false);
  else document.title = 'Forex Academy | SIF FOREX HUB';
  initializeAccountSync();
}
init();
