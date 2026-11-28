import { esc, renderPassage, fmtTime, fmtDate, answerText } from './shared.js';

const params = new URLSearchParams(location.search);
const volumeNo = Number(params.get('volume') || params.get('v') || 1);
const testNo = Number(params.get('test') || params.get('t') || 1);

const state = {
  testId: null,
  content: null,
  token: '',
  answers: {},
  flags: {},
  current: 0,
  currentPassage: 'p1',
  deadlineAt: null,
  attemptId: null,
  submitted: false,
  timer: null,
  saveTimer: null
};

async function request(path, options = {}, auth = true) {
  const headers = { ...(options.headers || {}) };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.style.display = 'block';
}

async function init() {
  try {
    const bootstrap = await request('/api/bootstrap', {}, false);
    const volume = bootstrap.volumes.find(v => v.number === volumeNo);
    const test = volume?.tests.find(t => t.number === testNo);
    if (!test) throw new Error(`找不到 Volume ${volumeNo} Test ${testNo}`);
    state.testId = test.id;
    const data = await request(`/api/tests/${test.id}`, {}, false);
    state.content = data.content;
    if (!state.content) throw new Error('该 Test 尚未上传题库内容');
    document.getElementById('examTitle').textContent = data.content.title || `Reading Test ${volumeNo}.${testNo}`;
    document.getElementById('examMeta').textContent = `Volume ${volumeNo} · Test ${testNo}`;
    state.currentPassage = data.content.passages[0]?.id || 'p1';
    state.flags = JSON.parse(localStorage.getItem(`ielts_flags_${state.testId}`) || '{}');

    state.token = localStorage.getItem(`ielts_student_token_${state.testId}`) || '';
    if (state.token) {
      try {
        const me = await request('/api/exam/me');
        if (me.attempt) {
          state.answers = me.attempt.answers || {};
          state.submitted = me.attempt.status === 'submitted';
          state.deadlineAt = me.attempt.deadlineAt;
          state.attemptId = me.attempt.id;
          if (state.submitted) {
            document.getElementById('loginModal').classList.remove('show');
            document.getElementById('submittedModal').classList.add('show');
          } else {
            enterExam();
          }
        }
      } catch { state.token = ''; }
    }
    bindUI();
  } catch (e) {
    showError('loginError', e.message);
  }
}

function bindUI() {
  document.getElementById('startBtn').onclick = startExam;
  document.getElementById('password').onkeydown = e => { if (e.key === 'Enter') startExam(); };
  document.getElementById('resultBtn').onclick = openResultModal;
  document.getElementById('backToLoginBtn').onclick = () => {
    document.getElementById('submittedModal').classList.remove('show');
    document.getElementById('loginModal').classList.add('show');
  };
  document.getElementById('prevBtn').onclick = () => goTo(state.current - 1);
  document.getElementById('nextBtn').onclick = () => goTo(state.current + 1);
  document.getElementById('flagBtn').onclick = toggleFlag;
  document.getElementById('reviewBtn').onclick = openReview;
  document.getElementById('submitBtn').onclick = confirmSubmit;
  document.getElementById('cancelSubmit').onclick = () => document.getElementById('submitConfirm').classList.remove('show');
  document.getElementById('confirmSubmit').onclick = () => submitExam(false);
}

async function startExam() {
  try {
    const login = await request('/api/exam/login', {
      method: 'POST',
      body: JSON.stringify({
        testId: state.testId,
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      })
    }, false);
    state.token = login.token;
    localStorage.setItem(`ielts_student_token_${state.testId}`, state.token);
    const started = await request('/api/exam/start', { method: 'POST', body: '{}' });
    state.attemptId = started.attemptId;
    state.deadlineAt = started.deadlineAt;
    const me = await request('/api/exam/me');
    state.answers = me.attempt?.answers || {};
    enterExam();
  } catch (e) {
    showError('loginError', e.message);
  }
}

function enterExam() {
  document.getElementById('loginModal').classList.remove('show');
  document.getElementById('submittedModal').classList.remove('show');
  document.getElementById('examShell').style.display = 'grid';
  renderPassages();
  renderQuestion();
  clearInterval(state.timer);
  state.timer = setInterval(tick, 500);
  tick();
}

function renderPassages() {
  const passages = state.content.passages || [];
  document.getElementById('passageTabs').innerHTML = passages.map((p, i) =>
    `<button class="passage-tab ${p.id === state.currentPassage ? 'active' : ''}" data-passage="${esc(p.id)}">${esc(p.title || `Passage ${i + 1}`)}</button>`).join('');
  const passage = passages.find(p => p.id === state.currentPassage) || passages[0];
  document.getElementById('passageContent').innerHTML = passage
    ? `<h3>${esc(passage.title || 'Reading Passage')}</h3>${renderPassage(passage.html, state.content.images || [])}`
    : '<p class="muted">暂无文章</p>';
  document.getElementById('passageTabs').onclick = e => {
    const btn = e.target.closest('[data-passage]');
    if (btn) { state.currentPassage = btn.dataset.passage; renderPassages(); }
  };
}

function renderQuestion() {
  const questions = state.content.questions || [];
  if (!questions.length) return;
  state.current = Math.max(0, Math.min(state.current, questions.length - 1));
  const q = questions[state.current];
  if (q.passageId) state.currentPassage = q.passageId;
  renderPassages();
  const section = (state.content.sections || []).find(s => (s.questionIds || []).includes(q.id));
  const sectionText = section?.instruction ? `<p class="muted small" style="margin-top:0">${esc(section.instruction)}</p>` : '';
  document.getElementById('questionPosition').textContent = `Question ${q.number} of ${questions.length}`;
  document.getElementById('questionScroll').innerHTML = `<div class="question-card">
    ${sectionText}
    <h3>${q.number}. ${esc(q.prompt)}</h3>
    ${questionBody(q)}
  </div>`;
  renderNav();
  bindAnswerEvents();
}

function parseOption(option) {
  const match = String(option).match(/^([A-Z])[\.\s:：\-–]+(.+)$/);
  return match ? { letter: match[1], text: match[2] } : { letter: '', text: String(option) };
}

function questionBody(q) {
  const value = state.answers[q.id];
  const options = q.options || [];
  if (q.type === 'mcq') {
    return `<div class="option-list">${options.map(o => {
      const op = parseOption(o);
      const checked = answerText(value) === (op.letter || op.text) ? 'checked' : '';
      return `<label class="option"><input type="radio" name="q_${q.id}" value="${esc(op.letter || op.text)}" ${checked} data-answer-input data-qid="${esc(q.id)}">
        ${op.letter ? `<span class="letter">${esc(op.letter)}</span>` : ''}<span>${esc(op.text)}</span></label>`;
    }).join('')}</div>`;
  }
  if (q.type === 'multiple') {
    const selected = Array.isArray(value) ? value : [];
    const max = q.maxAnswers ? `<div class="word-limit">Choose ${q.maxAnswers} answers.</div>` : '';
    return `${max}<div class="option-list">${options.map(o => {
      const op = parseOption(o);
      const checked = selected.includes(op.letter || op.text) ? 'checked' : '';
      return `<label class="option"><input type="checkbox" name="q_${q.id}" value="${esc(op.letter || op.text)}" ${checked} data-answer-input data-qid="${esc(q.id)}">
        ${op.letter ? `<span class="letter">${esc(op.letter)}</span>` : ''}<span>${esc(op.text)}</span></label>`;
    }).join('')}</div>`;
  }
  if (q.type === 'tfng' || q.type === 'ynng') {
    const opts = options.length ? options : (q.type === 'tfng' ? ['True', 'False', 'Not Given'] : ['Yes', 'No', 'Not Given']);
    return `<div class="three-options">${opts.map(o => `
      <label class="option"><input type="radio" name="q_${q.id}" value="${esc(o)}" ${answerText(value) === o ? 'checked' : ''} data-answer-input data-qid="${esc(q.id)}"><span>${esc(o)}</span></label>`).join('')}</div>`;
  }
  if (q.type === 'matching') {
    return `${q.context ? `<div class="question-context">${esc(q.context)}</div>` : ''}
      <select class="answer-input" data-answer-input data-qid="${esc(q.id)}">
        <option value="">Choose an answer</option>
        ${options.map(o => `<option value="${esc(o)}" ${answerText(value) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
  }
  const hint = q.wordLimit ? `<div class="word-limit">Write NO MORE THAN ${q.wordLimit} WORD${q.wordLimit > 1 ? 'S' : ''}.</div>` : '';
  return `${q.context ? `<div class="question-context">${esc(q.context)}</div>` : ''}${hint}
    <input class="answer-input" type="text" value="${esc(answerText(value))}" placeholder="Type your answer" data-answer-input data-qid="${esc(q.id)}">`;
}

function bindAnswerEvents() {
  const host = document.getElementById('questionScroll');
  host.onchange = e => {
    const input = e.target.closest('[data-answer-input]');
    if (!input) return;
    updateAnswer(input);
  };
  host.oninput = e => {
    const input = e.target.closest('[data-answer-input]');
    if (!input || input.type === 'radio' || input.type === 'checkbox' || input.tagName === 'SELECT') return;
    updateAnswer(input);
  };
}

function updateAnswer(input) {
  const qid = input.dataset.qid;
  const q = state.content.questions.find(x => x.id === qid);
  if (q?.type === 'multiple') {
    const checked = [...document.querySelectorAll(`input[name="q_${CSS.escape(qid)}"]:checked`)].map(x => x.value);
    state.answers[qid] = checked;
  } else {
    state.answers[qid] = input.value;
  }
  renderNav();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  document.getElementById('autoSaveStatus').textContent = '正在保存…';
  state.saveTimer = setTimeout(async () => {
    try {
      await request('/api/exam/save', { method: 'POST', body: JSON.stringify({ answers: state.answers }) });
      document.getElementById('autoSaveStatus').textContent = `已自动保存 ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      document.getElementById('autoSaveStatus').textContent = e.message;
      if (e.message.includes('时间')) autoSubmit();
    }
  }, 700);
}

function isAnswered(id) {
  const v = state.answers[id];
  return Array.isArray(v) ? v.length > 0 : String(v ?? '').trim().length > 0;
}

function renderNav() {
  const questions = state.content.questions || [];
  document.getElementById('questionNav').innerHTML = questions.map((q, i) => `
    <button class="q-num ${isAnswered(q.id) ? 'answered' : ''} ${i === state.current ? 'current' : ''} ${state.flags[q.id] ? 'flagged' : ''}" data-goto="${i}">${q.number}</button>`).join('');
  document.getElementById('questionNav').onclick = e => {
    const btn = e.target.closest('[data-goto]');
    if (btn) goTo(Number(btn.dataset.goto));
  };
}

function goTo(index) {
  const total = state.content.questions?.length || 0;
  if (index < 0 || index >= total) return;
  state.current = index;
  renderQuestion();
}

function toggleFlag() {
  const q = state.content.questions[state.current];
  if (!q) return;
  state.flags[q.id] = !state.flags[q.id];
  localStorage.setItem(`ielts_flags_${state.testId}`, JSON.stringify(state.flags));
  renderNav();
  document.getElementById('flagBtn').textContent = state.flags[q.id] ? 'Unflag' : 'Flag';
}

function openReview() {
  const questions = state.content.questions || [];
  document.getElementById('reviewContent').innerHTML = `<h2>Review Answers</h2>
    <p class="muted small">蓝色 = 已作答，红色边框 = 已标记。</p>
    <div class="review-grid">${questions.map((q, i) => `
      <button class="review-item ${isAnswered(q.id) ? 'answered' : ''} ${state.flags[q.id] ? 'flagged' : ''}" data-jump="${i}">
        <strong>${q.number}</strong><div class="small muted">${isAnswered(q.id) ? esc(answerText(state.answers[q.id])) : '未作答'}</div>
      </button>`).join('')}</div>
    <div class="modal-actions"><button class="btn" id="closeReview">关闭</button><button class="btn primary" id="reviewSubmit">Submit</button></div>`;
  document.getElementById('reviewModal').classList.add('show');
  document.getElementById('closeReview').onclick = () => document.getElementById('reviewModal').classList.remove('show');
  document.getElementById('reviewSubmit').onclick = () => { document.getElementById('reviewModal').classList.remove('show'); confirmSubmit(); };
  document.getElementById('reviewContent').onclick = e => {
    const btn = e.target.closest('[data-jump]');
    if (btn) { goTo(Number(btn.dataset.jump)); document.getElementById('reviewModal').classList.remove('show'); }
  };
}

function tick() {
  if (!state.deadlineAt) return;
  const remaining = new Date(state.deadlineAt).getTime() - Date.now();
  const el = document.getElementById('timer');
  el.textContent = fmtTime(remaining);
  el.classList.toggle('danger', remaining <= 5 * 60 * 1000);
  if (remaining <= 0) {
    clearInterval(state.timer);
    autoSubmit();
  }
}

function confirmSubmit() {
  const answered = (state.content.questions || []).filter(q => isAnswered(q.id)).length;
  const total = state.content.questions?.length || 0;
  document.getElementById('submitSummary').textContent = `已作答 ${answered} / ${total} 题。提交后不能修改。`;
  document.getElementById('submitConfirm').classList.add('show');
}

async function autoSubmit() {
  document.getElementById('submitConfirm').classList.remove('show');
  await submitExam(true);
}

async function submitExam(auto) {
  try {
    clearTimeout(state.saveTimer);
    await request('/api/exam/submit', { method: 'POST', body: JSON.stringify({ answers: state.answers }) });
    state.submitted = true;
    clearInterval(state.timer);
    document.getElementById('submitConfirm').classList.remove('show');
    document.getElementById('examShell').style.display = 'none';
    document.getElementById('submittedModal').querySelector('p').textContent = auto
      ? '考试时间已到，系统已自动提交。老师批改并发布成绩后，可输入姓名查看结果。'
      : '你的答案已保存。老师批改并发布成绩后，可输入姓名查看结果。';
    document.getElementById('submittedModal').classList.add('show');
  } catch (e) {
    alert(e.message);
  }
}

function openResultModal() {
  const modal = document.getElementById('resultModal');
  modal.innerHTML = `<h2>查看已发布成绩</h2>
    <label class="field"><span>学生姓名</span><input class="input" id="resultName" placeholder="请输入姓名"></label>
    <div id="resultList"></div>
    <div class="modal-actions"><button class="btn" id="closeResult">关闭</button><button class="btn primary" id="queryResult">查询</button></div>`;
  modal.parentElement.classList.add('show');
  document.getElementById('closeResult').onclick = () => modal.parentElement.classList.remove('show');
  document.getElementById('queryResult').onclick = queryResult;
  document.getElementById('resultName').onkeydown = e => { if (e.key === 'Enter') queryResult(); };
}

async function queryResult() {
  const name = document.getElementById('resultName').value.trim();
  if (!name) return;
  try {
    const data = await request('/api/exam/result', { method: 'POST', body: JSON.stringify({ name }) }, false);
    const list = document.getElementById('resultList');
    if (!data.results.length) {
      list.innerHTML = '<div class="notice">暂无已发布的成绩。请确认姓名正确，或等待老师发布。</div>';
      return;
    }
    list.innerHTML = data.results.map(r => `<div class="panel result-card" style="margin-bottom:12px">
      <h3>Volume ${r.volume} · Test ${r.test}</h3>
      <p>提交时间：${fmtDate(r.submittedAt)}</p>
      <p><strong>答对 ${r.score} / ${r.total} 题</strong> · <strong>雅思阅读分数：${Number(r.band).toFixed(1)}</strong></p>
      ${r.questions.map(q => `<div class="${q.correct ? 'right' : 'wrong'}">
        <strong>Q${q.number} ${q.correct ? '✓ 正确' : '✗ 错误'}</strong><div class="small">${esc(q.prompt)}</div>
        <div class="small">你的答案：<span style="color:#1769aa;font-weight:700">${esc(answerText(q.studentAnswer) || '未作答')}</span></div>
        <div class="small">正确答案：<span style="color:#1b8a5a;font-weight:700">${esc(answerText(q.correctAnswer))}</span></div>
      </div>`).join('')}
    </div>`).join('');
  } catch (e) {
    document.getElementById('resultList').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  }
}

init();
