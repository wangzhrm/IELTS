import { api, adminReady, esc, renderPassage, fmtDate, toast, answerText } from './shared.js';

const state = { attempts: [], currentId: null, detail: null, decisions: {} };

async function init() {
  await loadAttempts();
}

async function loadAttempts() {
  const data = await api('/api/grading/attempts');
  state.attempts = data.attempts;
  const host = document.getElementById('attemptList');
  host.innerHTML = data.attempts.map(a => `
    <div class="attempt-item ${a.id === state.currentId ? 'active' : ''}" data-attempt="${a.id}">
      <strong>${esc(a.studentName)}</strong>
      <div class="small muted">V${a.volume} · T${a.test} · ${fmtDate(a.submittedAt)}</div>
      <div class="small">${a.score != null ? `答对 ${a.score}/${a.total || '?'} · ${Number(a.band).toFixed(1)}` : '待批改'}
        ${a.published ? '<span class="chip" style="color:var(--green)">已发布</span>' : ''}</div>
    </div>`).join('') || '<div class="notice">暂无已提交答卷。学生提交后会出现在这里。</div>';
  host.onclick = e => {
    const item = e.target.closest('[data-attempt]');
    if (item) selectAttempt(Number(item.dataset.attempt));
  };
  if (data.attempts.length && !state.currentId) await selectAttempt(data.attempts[0].id);
}

async function selectAttempt(id) {
  state.currentId = id;
  const data = await api(`/api/grading/${id}`);
  state.detail = data;
  state.decisions = {};
  (data.content?.questions || []).forEach(q => {
    const reportItem = (data.attempt.report || []).find(r => r.questionId === q.id);
    state.decisions[q.id] = reportItem ? !!reportItem.correct : false;
  });
  await loadAttempts();
  renderSummary();
  renderArticle();
  renderQuestions();
}

function renderSummary() {
  const a = state.detail.attempt;
  const content = state.detail.content || {};
  const correctCount = Object.values(state.decisions).filter(Boolean).length;
  const total = content.questions?.length || 0;
  const scaledScore = total ? Math.round(correctCount / total * 40) : 0;
  document.getElementById('summaryPanel').innerHTML = `
    <div class="panel-title"><h2>${esc(a.studentName)} · Volume ${a.volume} · Test ${a.test}</h2>
      <span class="muted small">提交于 ${fmtDate(a.submittedAt)}</span></div>
    <div class="notice">当前判定：答对 <strong>${correctCount}</strong> / ${total} 题 · 折算 40 题约 <strong>${scaledScore}</strong> 题 · 雅思阅读分数 <strong>${total ? band(correctCount, total).toFixed(1) : '—'}</strong>
      ${a.published ? ' · <strong style="color:var(--green)">成绩已发布</strong>' : ''}</div>
    <div class="small muted">评分按 Academic Reading 40 题量表；题库题数不同则按比例折算到 40 题。</div>`;
}

function band(score, total) {
  const scaled = Math.round(score / total * 40);
  const table = [[39,9],[37,8.5],[35,8],[33,7.5],[30,7],[27,6.5],[23,6],[19,5.5],[15,5],[13,4.5],[10,4],[8,3.5],[6,3],[4,2.5],[2,2],[1,1],[0,0]];
  return table.find(([min]) => scaled >= min)[1];
}

function renderArticle() {
  const passages = state.detail.content?.passages || [];
  document.getElementById('articlePanel').style.display = 'block';
  document.getElementById('gradeArticle').innerHTML = passages.map(p =>
    `<section><h3>${esc(p.title)}</h3>${renderPassage(p.html, state.detail.content?.images || [])}</section>`).join('<hr>');
}

function parseOption(option) {
  const match = String(option).match(/^([A-Z])[\.\s:：\-–]+(.+)$/);
  return match ? { letter: match[1], text: match[2] } : { letter: '', text: String(option) };
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function renderQuestions() {
  const content = state.detail.content || {};
  const answers = state.detail.attempt.answers || {};
  const report = state.detail.attempt.report || [];
  document.getElementById('questionsPanel').style.display = 'block';
  document.getElementById('gradeQuestions').innerHTML = (content.questions || []).map(q => {
    const student = asArray(answers[q.id]);
    const correct = asArray(q.answer);
    const isCorrect = !!state.decisions[q.id];
    const decidedBy = report.find(r => r.questionId === q.id)?.decidedBy || 'auto';
    const optionHtml = (q.options || []).map(o => {
      const op = parseOption(o);
      const key = op.letter || op.text;
      const isStudent = student.includes(key);
      const isCorrectOpt = correct.includes(key);
      const classes = ['option-mark'];
      if (isStudent) classes.push('student-mark');
      if (isCorrectOpt) classes.push('correct-mark');
      return `<div class="${classes.join(' ')}">${op.letter ? `<strong>${esc(op.letter)}.</strong> ` : ''}${esc(op.text)}
        ${isStudent ? '<span class="small">（学生答案）</span>' : ''}${isCorrectOpt ? '<span class="small">（正确答案）</span>' : ''}</div>`;
    }).join('');
    return `<div class="grade-q">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <strong>Q${q.number}. ${esc(q.prompt)}</strong>
        <span class="chip" style="color:${isCorrect ? 'var(--green)' : 'var(--red)'}">${isCorrect ? '正确' : '错误'}</span>
      </div>
      ${q.context ? `<div class="small muted">${esc(q.context)}</div>` : ''}
      ${student.length || correct.length ? `
        <div class="answer-line student-mark">学生答案：<strong>${esc(student.join(', ') || '未作答')}</strong></div>
        <div class="answer-line correct-mark">正确答案：<strong>${esc(correct.join(', ') || '未设置')}</strong></div>` : ''}
      ${optionHtml}
      <label class="decision"><input type="checkbox" data-decision="${esc(q.id)}" ${isCorrect ? 'checked' : ''}> 判为正确
        <span class="small muted">（${decidedBy === 'ai' ? 'AI 初判' : '系统/人工初判'}，可人工覆盖）</span></label>
    </div>`;
  }).join('') || '<div class="notice">该题库没有题目。</div>';
  document.getElementById('gradeQuestions').onchange = e => {
    const input = e.target.closest('[data-decision]');
    if (!input) return;
    state.decisions[input.dataset.decision] = input.checked;
    renderSummary();
  };
}

async function aiGrade() {
  try {
    toast('正在调用 AI 比对…');
    const result = await api(`/api/ai/grade/${state.currentId}`, { method: 'POST', body: '{}' });
    result.results.forEach(r => { state.decisions[r.questionId] = !!r.correct; });
    renderQuestions();
    renderSummary();
    toast('AI 比对完成，请人工核实');
  } catch (e) { toast(e.message, true); }
}

async function saveGrade(publish) {
  try {
    const content = state.detail.content || {};
    const answers = state.detail.attempt.answers || {};
    const report = (content.questions || []).map(q => ({
      questionId: q.id,
      studentAnswer: answers[q.id] ?? '',
      correctAnswer: q.answer || [],
      correct: !!state.decisions[q.id],
      decidedBy: state.decisions[q.id] === undefined ? 'ai' : 'teacher'
    }));
    const result = await api(`/api/grading/${state.currentId}`, {
      method: 'POST',
      body: JSON.stringify({ report, publish })
    });
    toast(publish ? '成绩已保存并发布，学生可查看' : '批改结果已保存');
    state.detail.attempt.published = result.published;
    await loadAttempts();
    await selectAttempt(state.currentId);
  } catch (e) { toast(e.message, true); }
}

function bindButtons() {
  document.getElementById('aiGradeBtn').onclick = aiGrade;
  document.getElementById('saveGradeBtn').onclick = () => saveGrade(false);
  document.getElementById('publishBtn').onclick = () => saveGrade(true);
}

adminReady(async () => { bindButtons(); await init(); });
