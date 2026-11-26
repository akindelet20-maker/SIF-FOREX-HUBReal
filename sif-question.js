import { ACADEMY_MODULES } from './academy-data.js';

const PROGRESS_KEY = 'sifForexAcademyProgress.v2';
const LEGACY_KEY = 'sifForexAcademyStartHere.v1';
const PASS_SCORE = 4;
const allLessons = ACADEMY_MODULES.flatMap((module) => module.lessons.map((lesson, index) => ({ ...lesson, module, moduleLessonNumber: index + 1 })));
const lessonById = new Map(allLessons.map((lesson) => [lesson.id, lesson]));
const validIds = new Set(allLessons.map((lesson) => lesson.id));
const moduleDataCache = new Map();
const els = {
  grid: document.getElementById('question-module-grid'), search: document.getElementById('question-search'), noResults: document.getElementById('question-no-results'),
  catalog: document.getElementById('question-catalog'), session: document.getElementById('question-session'), sessionContent: document.getElementById('question-session-content'),
  status: document.getElementById('question-save-status'), notice: document.getElementById('question-notice'),
};

function safeRead(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cleanIds = (items) => Array.isArray(items) ? [...new Set(items.map(String).filter((id) => validIds.has(id)))] : [];
  const history = Array.isArray(source.history) ? source.history.filter((event) => event && typeof event === 'object' && validIds.has(String(event.lessonId))).slice(0, 120) : [];
  return {
    version: 2, completed: cleanIds(source.completed), bookmarks: cleanIds(source.bookmarks),
    quizAttempts: Math.max(0, Number(source.quizAttempts) || 0), history,
    lastLessonId: validIds.has(String(source.lastLessonId)) ? String(source.lastLessonId) : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString(),
  };
}
function loadState() {
  const existing = safeRead(PROGRESS_KEY);
  if (existing) return normalizeState(existing);
  const migrated = normalizeState(null);
  const old = safeRead(LEGACY_KEY);
  if (Array.isArray(old?.completed)) {
    old.completed.map(String).filter((id) => ['1', '2', '3', '4'].includes(id)).forEach((id) => migrated.completed.push(`m1-l${id}`));
    if (migrated.completed.length) migrated.history.push({ type: 'migrated', lessonId: migrated.completed[migrated.completed.length - 1], at: new Date().toISOString() });
  }
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(migrated)); } catch { /* local progress is best-effort */ }
  return migrated;
}
function eventId(event) { return `${event.type}|${event.lessonId}|${event.at}|${event.score ?? ''}`; }
function mergeStates(left, right) {
  const a = normalizeState(left);
  const b = normalizeState(right);
  const history = new Map();
  [...a.history, ...b.history].forEach((event) => history.set(eventId(event), event));
  const mergedHistory = [...history.values()].sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, 120);
  const aTime = Date.parse(a.updatedAt) || 0;
  const bTime = Date.parse(b.updatedAt) || 0;
  return {
    version: 2, completed: [...new Set([...a.completed, ...b.completed])], bookmarks: [...new Set([...a.bookmarks, ...b.bookmarks])],
    quizAttempts: Math.max(a.quizAttempts, b.quizAttempts), history: mergedHistory,
    lastLessonId: bTime > aTime ? (b.lastLessonId || a.lastLessonId) : (a.lastLessonId || b.lastLessonId),
    updatedAt: bTime > aTime ? b.updatedAt : a.updatedAt,
  };
}
let state = loadState();
let currentLesson = null;
let currentUser = null;
let supabase = null;
let remoteTableReady = false;
let remoteSyncBusy = false;
let remoteWriteTimer = null;
let authListenerInstalled = false;
let activityCounter = 0;

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('is-error', error);
}
function showNotice(message, error = false) {
  els.notice.textContent = message;
  els.notice.classList.toggle('is-error', error);
  els.notice.hidden = false;
}
function completed(id) { return state.completed.includes(id); }
function unlocked(id) {
  if (completed(id)) return true;
  const index = allLessons.findIndex((lesson) => lesson.id === id);
  if (index <= 0) return index === 0;
  return allLessons.slice(0, index).every((lesson) => completed(lesson.id));
}
function firstIncomplete() { return allLessons.find((lesson) => !completed(lesson.id)) || allLessons[allLessons.length - 1]; }
function completedInModule(module) { return module.lessons.filter((lesson) => completed(lesson.id)).length; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function persistState(queueRemote = true) {
  state.version = 2;
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
    setStatus(currentUser && remoteTableReady ? 'Saving assessment progress to your account…' : 'Progress saves on this device.');
  } catch {
    setStatus('Browser storage is unavailable; keep this tab open to retain progress.', true);
  }
  if (queueRemote && currentUser && remoteTableReady) {
    window.clearTimeout(remoteWriteTimer);
    remoteWriteTimer = window.setTimeout(() => syncProgressToAccount(), 250);
  }
}
function addHistory(type, lesson, extra = {}) {
  const event = { type, lessonId: lesson.id, at: new Date().toISOString(), ...extra, _key: `${Date.now()}-${activityCounter++}` };
  state.history.unshift(event);
  state.history = state.history.slice(0, 120);
}
async function syncProgressToAccount() {
  if (!supabase || !currentUser || !remoteTableReady || remoteSyncBusy) return;
  remoteSyncBusy = true;
  setStatus('Saving assessment progress to your account…');
  try {
    const { error } = await supabase.from('academy_progress').upsert({
      user_id: currentUser.id, progress: state, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
    setStatus('Assessment progress is saved on this device and synced to your account.');
  } catch (error) {
    remoteTableReady = false;
    setStatus('Saved on this device. Account sync is unavailable; your learning progress remains safe.', true);
    showNotice('Account-based progress sync is not available yet. SIF Question continues to save progress on this device.', true);
    console.warn('SIF Question account sync is unavailable.', error?.message || '');
  } finally {
    remoteSyncBusy = false;
  }
}
async function loadAccountProgress() {
  if (!supabase || !currentUser) return;
  try {
    const { data: remoteRow, error } = await supabase.from('academy_progress').select('progress,updated_at').eq('user_id', currentUser.id).maybeSingle();
    if (error) throw error;
    remoteTableReady = true;
    if (remoteRow?.progress) state = mergeStates(state, remoteRow.progress);
    persistState(false);
    await syncProgressToAccount();
  } catch (error) {
    remoteTableReady = false;
    setStatus('Saved on this device. Account sync is not available yet.', true);
    showNotice('Your questions and progress remain available. The account progress table is not ready, so this section is using device storage.', true);
    console.info('SIF Question is running in device-save mode.', error?.message || '');
  }
}
async function initializeAccountSync() {
  try {
    if (!supabase) {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = createClient('https://kfaqrjhwbmkawnxkcrld.supabase.co', 'sb_publishable_-kdg7Pmr_mWPPfnv83VTMA_n2hhKXhk');
    }
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    currentUser = data?.session?.user || null;
    if (!authListenerInstalled) {
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session?.user) {
          currentUser = session.user;
          loadAccountProgress();
        } else if (event === 'SIGNED_OUT') {
          currentUser = null;
          remoteTableReady = false;
          setStatus('Progress saves on this device.');
        }
      });
      authListenerInstalled = true;
    }
    if (currentUser) await loadAccountProgress();
  } catch (error) {
    setStatus('Progress saves on this device. Account sync could not connect.', true);
    console.info('SIF Question is running in guest/device-save mode.', error?.message || '');
  }
}

function renderCatalog() {
  const query = (els.search.value || '').trim().toLowerCase();
  const active = firstIncomplete();
  els.grid.innerHTML = ACADEMY_MODULES.map((module) => {
    const matchingLessons = module.lessons.filter((lesson) => lesson.title.toLowerCase().includes(query));
    const moduleMatches = !query || module.title.toLowerCase().includes(query) || module.description.toLowerCase().includes(query);
    const hasMatch = moduleMatches || matchingLessons.length > 0;
    const done = completedInModule(module);
    const rows = module.lessons.map((lesson, index) => {
      const isDone = completed(lesson.id);
      const isOpen = unlocked(lesson.id);
      const shouldShow = !query || moduleMatches || matchingLessons.includes(lesson);
      const status = isDone ? 'PASSED' : isOpen ? (active?.id === lesson.id ? 'READY NEXT' : 'READY') : 'LOCKED';
      const cls = `sifq-lesson-link${isDone ? ' is-done' : ''}${isOpen ? '' : ' is-locked'}`;
      const icon = isDone ? '✓' : isOpen ? String(index + 1) : '⌑';
      if (isOpen) return `<a class="${cls}" href="sif-question.html?lesson=${encodeURIComponent(lesson.id)}" ${shouldShow ? '' : 'hidden'}><span class="sifq-lesson-state" aria-hidden="true">${icon}</span><span class="sifq-lesson-title">${escapeHtml(lesson.title)}</span><span class="sifq-lesson-status">${status}</span></a>`;
      return `<div class="${cls}" aria-disabled="true" title="Pass the earlier assessment first" ${shouldShow ? '' : 'hidden'}><span class="sifq-lesson-state" aria-hidden="true">${icon}</span><span class="sifq-lesson-title">${escapeHtml(lesson.title)}</span><span class="sifq-lesson-status">${status}</span></div>`;
    }).join('');
    return `<details class="sifq-module" data-module="${module.id}" ${!query && module.id === active?.module.id ? 'open' : ''} ${hasMatch ? '' : 'hidden'}><summary><span class="sifq-module-number">${String(module.id).padStart(2, '0')}</span><span><span class="sifq-module-title">${escapeHtml(module.title)}</span><span class="sifq-module-description">${escapeHtml(module.description)}</span></span><span class="sifq-module-progress">${done}/${module.lessons.length} passed</span></summary><div class="sifq-question-list">${rows}</div></details>`;
  }).join('');
  const visible = [...els.grid.querySelectorAll('.sifq-module')].some((card) => !card.hidden);
  els.noResults.hidden = !query || visible;
}
function firstRequiredLesson(lessonId) {
  const index = allLessons.findIndex((item) => item.id === lessonId);
  if (index <= 0) return null;
  return allLessons.slice(0, index).find((item) => !completed(item.id)) || null;
}
async function openAssessment(lessonId) {
  currentLesson = lessonById.get(lessonId) || null;
  els.catalog.hidden = true;
  els.session.hidden = false;
  if (!currentLesson) {
    els.sessionContent.innerHTML = '<div class="sifq-locked-card"><span class="academy-section-kicker">ASSESSMENT NOT FOUND</span><h2>We could not find that lesson</h2><p>Choose a lesson from the question library. Your saved progress is unchanged.</p><a href="sif-question.html">Return to all SIF Questions →</a></div>';
    return;
  }
  if (!unlocked(lessonId)) {
    const required = firstRequiredLesson(lessonId);
    els.sessionContent.innerHTML = `<div class="sifq-locked-card"><span class="academy-section-kicker">ASSESSMENT LOCKED · KEEP YOUR PLACE</span><h2>${escapeHtml(currentLesson.title)}</h2><p>Pass the earlier assessment first. Your next available assessment is <strong>${escapeHtml(required?.title || 'the previous lesson')}</strong>.</p><a href="academy.html?lesson=${encodeURIComponent(required?.id || allLessons[0].id)}">Study the next lesson in Academy →</a> <a href="sif-question.html">Browse all questions</a></div>`;
    return;
  }
  els.sessionContent.innerHTML = `<header class="sifq-session-header"><span class="academy-section-kicker">MODULE ${String(currentLesson.module.id).padStart(2, '0')} · LESSON ${currentLesson.moduleLessonNumber} OF ${currentLesson.module.lessons.length}</span><h2 id="question-session-title">${escapeHtml(currentLesson.title)}</h2><p>${escapeHtml(currentLesson.module.title)} · Five questions · Pass with ${PASS_SCORE}/5. ${completed(lessonId) ? 'This assessment is already passed; you may retake it.' : 'Take your time and review the explanations.'}</p></header><div class="lesson-quiz"><div class="quiz-heading"><div><span class="academy-section-kicker">SIF QUESTION</span><h3>Check your understanding</h3><p>Choose one answer for each question. Explanations appear after you check your answers.</p></div><span class="quiz-count">5 QUESTIONS</span></div><div id="question-form-host"><p class="loading-modules">Loading this lesson’s assessment…</p></div></div>`;
  state.lastLessonId = lessonId;
  persistState();
  try {
    let moduleData = moduleDataCache.get(currentLesson.module.id);
    if (!moduleData) {
      const response = await fetch(`academy-content/module-${String(currentLesson.module.id).padStart(2, '0')}.json`, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Assessment file request failed (${response.status})`);
      moduleData = await response.json();
      moduleDataCache.set(currentLesson.module.id, moduleData);
    }
    const fullLesson = moduleData.lessons.find((item) => item.id === currentLesson.id);
    if (!fullLesson || !Array.isArray(fullLesson.quiz) || fullLesson.quiz.length !== 5) throw new Error('Assessment record is missing or invalid');
    mountQuiz(fullLesson);
  } catch (error) {
    const host = document.getElementById('question-form-host');
    if (host) host.innerHTML = '<div class="sifq-locked-card"><h2>Assessment unavailable</h2><p>We could not load this question file. Your progress is unchanged. Check your connection and try again.</p><button type="button" id="retry-load-assessment">Try again</button></div>';
    document.getElementById('retry-load-assessment')?.addEventListener('click', () => openAssessment(lessonId));
    console.warn('SIF Question assessment did not load.', error?.message || '');
  }
}
function mountQuiz(fullLesson) {
  const host = document.getElementById('question-form-host');
  if (!host) return;
  const items = fullLesson.quiz.map((question, index) => `<fieldset class="quiz-question" data-question="${index}"><legend>${index + 1}. ${escapeHtml(question.question)}</legend><div class="quiz-options">${question.options.map((option, optionIndex) => `<label class="quiz-option" data-option="${optionIndex}"><input type="radio" name="q-${escapeHtml(fullLesson.id)}-${index}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div><p class="quiz-explanation" data-explanation="${index}" aria-live="polite"></p></fieldset>`).join('');
  const index = allLessons.findIndex((lesson) => lesson.id === fullLesson.id);
  const next = allLessons[index + 1];
  host.innerHTML = `<form class="lesson-quiz-form" id="sif-question-form" data-lesson-quiz="${escapeHtml(fullLesson.id)}">${items}<div class="quiz-controls"><button class="quiz-submit-btn" type="submit">Check my answers</button><button class="quiz-retry-btn" type="button" data-retry-quiz hidden>Try again</button><span class="quiz-feedback" role="status" aria-live="polite"></span></div><div class="sifq-question-actions"><a data-return-lesson href="academy.html?lesson=${encodeURIComponent(fullLesson.id)}" hidden>Return to this lesson →</a>${next ? `<a data-next-lesson href="academy.html?lesson=${encodeURIComponent(next.id)}" hidden>Read the next lesson →</a>` : ''}</div></form>`;
  host.querySelector('form').dataset.quizData = JSON.stringify(fullLesson.quiz);
}
function submitQuiz(form) {
  if (!currentLesson) return;
  const questions = form.querySelectorAll('.quiz-question');
  const chosen = [...questions].map((fieldset) => fieldset.querySelector('input[type="radio"]:checked'));
  const feedback = form.querySelector('.quiz-feedback');
  if (chosen.some((input) => !input)) {
    feedback.textContent = `Answer all ${questions.length} questions before checking your score.`;
    feedback.className = 'quiz-feedback is-retry';
    return;
  }
  const selectedLesson = currentLesson;
  let score = 0;
  // Loaded question records are kept on the current form for deterministic scoring.
  const questionsData = JSON.parse(form.dataset.quizData || '[]');
  questionsData.forEach((question, index) => {
    const selected = Number(chosen[index].value);
    const correct = Number(question.correct);
    if (selected === correct) score += 1;
    const fieldset = questions[index];
    fieldset.querySelectorAll('.quiz-option').forEach((option) => {
      const optionIndex = Number(option.dataset.option);
      option.classList.toggle('is-correct', optionIndex === correct);
      option.classList.toggle('is-wrong', optionIndex === selected && selected !== correct);
      option.querySelector('input').disabled = true;
    });
    const explanation = fieldset.querySelector('.quiz-explanation');
    explanation.textContent = `${selected === correct ? 'Correct' : `Review: the best answer is “${question.options[correct]}”.`} ${question.explanation}`;
    explanation.classList.add('is-visible');
  });
  state.quizAttempts += 1;
  addHistory('quiz', selectedLesson, { score });
  const passed = score >= PASS_SCORE;
  if (passed && !completed(selectedLesson.id)) {
    state.completed.push(selectedLesson.id);
    addHistory('complete', selectedLesson, { score });
  }
  persistState();
  form.querySelector('.quiz-submit-btn').hidden = true;
  form.querySelector('[data-retry-quiz]').hidden = false;
  const returnLink = form.querySelector('[data-return-lesson]');
  const nextLink = form.querySelector('[data-next-lesson]');
  returnLink.hidden = !passed;
  if (nextLink) nextLink.hidden = !passed;
  feedback.textContent = passed
    ? `${score}/5 — assessment passed. This lesson is complete and the next assessment is unlocked. Review every explanation before you continue.`
    : `${score}/5 — you need ${PASS_SCORE}/5 to pass. Review the explanations and try again.`;
  feedback.className = `quiz-feedback ${passed ? 'is-pass' : 'is-retry'}`;
  renderCatalog();
}
function retryQuiz(form) {
  form.querySelectorAll('input[type="radio"]').forEach((input) => { input.checked = false; input.disabled = false; });
  form.querySelectorAll('.quiz-option').forEach((option) => option.classList.remove('is-correct', 'is-wrong'));
  form.querySelectorAll('.quiz-explanation').forEach((item) => { item.textContent = ''; item.classList.remove('is-visible'); });
  form.querySelector('.quiz-feedback').textContent = '';
  form.querySelector('.quiz-feedback').className = 'quiz-feedback';
  form.querySelector('.quiz-submit-btn').hidden = false;
  form.querySelector('[data-retry-quiz]').hidden = true;
  form.querySelector('[data-return-lesson]').hidden = true;
  const nextLink = form.querySelector('[data-next-lesson]');
  if (nextLink) nextLink.hidden = true;
}
els.search.addEventListener('input', renderCatalog);
els.sessionContent.addEventListener('submit', (event) => {
  if (!event.target.matches('[data-lesson-quiz]')) return;
  event.preventDefault();
  submitQuiz(event.target);
});
els.sessionContent.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry-quiz]');
  if (retry) retryQuiz(retry.closest('form'));
});
window.addEventListener('pageshow', () => {
  state = mergeStates(state, loadState());
  renderCatalog();
});

async function init() {
  renderCatalog();
  const lessonId = new URLSearchParams(window.location.search).get('lesson');
  if (lessonId) await openAssessment(lessonId);
  initializeAccountSync();
}
init();
