import { api, adminReady, esc, renderPassage, toast, fmtDate } from './shared.js';

const state = {
  token: '',
  volumes: [],
  volumeId: 1,
  testId: null,
  content: null,
  answers: {},
  images: [],
  pages: [],
  lastTextarea: null
};

const TYPE_LABELS = {
  mcq: '单项选择题', multiple: '多项选择题', tfng: 'True / False / Not Given',
  ynng: 'Yes / No / Not Given', matching: '匹配题', completion: '摘要 / 笔记填空',
  'short-answer': '简答题', diagram: '图表 / 流程图填空'
};

function emptyContent() {
  return {
    title: 'IELTS Academic Reading Test',
    instructions: 'You should spend about 20 minutes on each passage. Answer all questions.',
    timeLimitMinutes: 60,
    passages: [{ id: 'p1', title: 'Reading Passage 1', html: '' }],
    sections: [],
    questions: [],
    images: []
  };
}

function normalizeContent(content) {
  const c = content || emptyContent();
  c.timeLimitMinutes = 60;
  c.passages ||= [];
  c.questions ||= [];
  c.sections ||= [];
  c.images ||= [];
  c.questions.forEach((q, i) => {
    q.id ||= `q${i + 1}`;
    q.number = Number(q.number) || i + 1;
    q.type ||= 'completion';
    q.prompt ||= '';
    q.options ||= [];
    q.answer ||= [];
    if (!Array.isArray(q.answer)) q.answer = [q.answer];
    q.passageId ||= c.passages[0]?.id || 'p1';
  });
  return c;
}

function lineToArray(value) {
  return String(value || '').split('\n').map(x => x.trim()).filter(Boolean);
}

function arrayToText(value) {
  return Array.isArray(value) ? value.join('\n') : (value ? String(value) : '');
}

async function init() {
  const data = await api('/api/bootstrap');
  state.volumes = data.volumes;
  renderVolumePicker();
  await selectVolume(1);
  await selectTest(1);
  await loadStudents();
  await loadAiConfig();
  bindUI();
}

function renderVolumePicker() {
  document.getElementById('volumePicker').innerHTML = state.volumes.map(v =>
    `<button class="chip ${v.id === state.volumeId ? 'active' : ''}" data-volume="${v.id}">Vol ${v.number}</button>`).join('');
}

function renderTestPicker() {
  const volume = state.volumes.find(v => v.id === state.volumeId);
  document.getElementById('testPicker').innerHTML = (volume?.tests || []).map(t =>
    `<button class="chip ${t.id === state.testId ? 'active' : ''} ${t.hasContent ? 'has-content' : ''}" data-test="${t.id}">Test ${t.number}</button>`).join('');
}

async function selectVolume(id) {
  state.volumeId = Number(id);
  renderVolumePicker();
  renderTestPicker();
}

async function selectTest(id) {
  state.testId = Number(id);
  renderTestPicker();
  document.getElementById('curVolume').textContent = state.volumes.find(v => v.id === state.volumeId)?.number || '';
  const test = state.volumes.find(v => v.id === state.volumeId)?.tests.find(t => t.id === state.testId);
  document.getElementById('curTest').textContent = test?.number || '';
  document.getElementById('testMeta').textContent = test?.hasContent ? `已保存 · ${test.questionCount} 题` : '空题库';
  const data = await api(`/api/tests/${state.testId}`);
  state.content = normalizeContent(data.content);
  state.answers = data.answers || {};
  state.images = state.content.images || [];
  document.getElementById('paperTitle').value = state.content.title || '';
  document.getElementById('paperInstructions').value = state.content.instructions || '';
  renderPassageEditor();
  renderQuestionEditor();
  renderPreview();
}

function bindUI() {
  document.getElementById('volumePicker').onclick = e => {
    const btn = e.target.closest('[data-volume]');
    if (btn) selectVolume(btn.dataset.volume);
  };
  document.getElementById('testPicker').onclick = e => {
    const btn = e.target.closest('[data-test]');
    if (btn) selectTest(btn.dataset.test);
  };
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
    };
  });
  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('ielts_token');
    location.reload();
  };
  document.getElementById('parseBtn').onclick = parsePdf;
  document.getElementById('generateAnswersBtn').onclick = generateAnswers;
  document.getElementById('saveBtn').onclick = saveTest;
  document.getElementById('addPassageBtn').onclick = () => {
    state.content.passages.push({ id: `p${state.content.passages.length + 1}`, title: `Reading Passage ${state.content.passages.length + 1}`, html: '' });
    renderPassageEditor(); renderQuestionEditor(); renderPreview();
  };
  document.getElementById('addQuestionBtn').onclick = () => {
    const id = `q${Date.now().toString(36)}`;
    state.content.questions.push({ id, number: state.content.questions.length + 1, type: 'completion', passageId: state.content.passages[0]?.id || 'p1', prompt: '', options: [], answer: [] });
    renderQuestionEditor(); renderPreview();
  };
  document.getElementById('paperTitle').oninput = e => { state.content.title = e.target.value; };
  document.getElementById('paperInstructions').oninput = e => { state.content.instructions = e.target.value; };
  document.getElementById('addStudentBtn').onclick = () => openStudentModal();
  document.getElementById('saveAiBtn').onclick = saveAiConfig;
  document.getElementById('changeAdminPwdBtn').onclick = openAdminPwdModal;
}

function renderPassageEditor() {
  const host = document.getElementById('passageEditor');
  host.innerHTML = state.content.passages.map((p, i) => `
    <div class="editor-card">
      <div class="editor-head">
        <strong>Passage ${i + 1}</strong>
        <button class="btn sm danger" data-del-passage="${i}">删除</button>
      </div>
      <label class="field"><span>标题</span><input class="input" data-p="${i}" data-field="title" value="${esc(p.title)}"></label>
      <label class="field"><span>文章 HTML（图片位置用 [[IMAGE:1]] 表示）</span>
        <textarea class="textarea" data-p="${i}" data-field="html" style="min-height:200px">${esc(p.html)}</textarea>
      </label>
      <div class="small muted">点击图片可在光标处插入标记：</div>
      <div class="image-strip">
        ${state.images.map((img, n) => `<figure><img data-marker="${n + 1}" src="${esc(img.dataUrl)}" title="插入 [[IMAGE:${n + 1}]]"><figcaption>IMAGE:${n + 1}</figcaption></figure>`).join('') || '<span class="muted small">暂无图片</span>'}
      </div>
    </div>`).join('');
  host.oninput = e => {
    const target = e.target;
    if (target.dataset.p === undefined) return;
    state.content.passages[Number(target.dataset.p)][target.dataset.field] = target.value;
    renderPreview();
  };
  host.onfocusin = e => { if (e.target.tagName === 'TEXTAREA') state.lastTextarea = e.target; };
  host.onclick = e => {
    const del = e.target.closest('[data-del-passage]');
    if (del) {
      state.content.passages.splice(Number(del.dataset.delPassage), 1);
      renderPassageEditor(); renderQuestionEditor(); renderPreview();
      return;
    }
    const img = e.target.closest('[data-marker]');
    if (img) {
      const marker = `[[IMAGE:${img.dataset.marker}]]`;
      const ta = state.lastTextarea || host.querySelector('textarea');
      if (ta) {
        const start = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + marker + ta.value.slice(start);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  };
}

function renderQuestionEditor() {
  const host = document.getElementById('questionEditor');
  host.innerHTML = state.content.questions.map((q, i) => `
    <div class="editor-card">
      <div class="editor-head">
        <strong>Question ${q.number}</strong>
        <button class="btn sm danger" data-del-q="${i}">删除</button>
      </div>
      <div class="grid cols-4">
        <label class="field"><span>题号</span><input class="input" type="number" data-q="${i}" data-field="number" value="${q.number}"></label>
        <label class="field"><span>题型</span><select class="select" data-q="${i}" data-field="type">
          ${Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label class="field"><span>所属文章</span><select class="select" data-q="${i}" data-field="passageId">
          ${state.content.passages.map(p => `<option value="${esc(p.id)}" ${q.passageId === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select></label>
        <label class="field"><span>词数限制</span><input class="input" type="number" data-q="${i}" data-field="wordLimit" value="${q.wordLimit || ''}"></label>
      </div>
      <label class="field"><span>共享说明 / 表格说明（可空）</span><textarea class="textarea" data-q="${i}" data-field="context" style="min-height:60px">${esc(q.context || '')}</textarea></label>
      <label class="field"><span>题干</span><textarea class="textarea" data-q="${i}" data-field="prompt" style="min-height:60px">${esc(q.prompt)}</textarea></label>
      <div class="grid cols-2">
        <label class="field"><span>选项（每行一个）</span><textarea class="textarea" data-q="${i}" data-field="options">${esc(arrayToText(q.options))}</textarea></label>
        <label class="field"><span>正确答案（每题一行；多选写多行；可接受答案用 | 分隔）</span><textarea class="textarea" data-q="${i}" data-field="answer">${esc(arrayToText(q.answer))}</textarea></label>
      </div>
      <label class="field small"><span>多选允许数量（仅多项选择题）</span><input class="input" type="number" data-q="${i}" data-field="maxAnswers" value="${q.maxAnswers || ''}"></label>
    </div>`).join('') || '<div class="notice">还没有题目。上传 PDF 解析，或点击「+ 新增题目」。</div>';
  host.oninput = e => {
    const t = e.target;
    if (t.dataset.q === undefined) return;
    const q = state.content.questions[Number(t.dataset.q)];
    const field = t.dataset.field;
    if (field === 'options' || field === 'answer') {
      q[field] = lineToArray(t.value);
      if (field === 'answer') state.answers[q.id] = q.answer;
    } else if (['number', 'wordLimit', 'maxAnswers'].includes(field)) {
      q[field] = t.value ? Number(t.value) : null;
    } else {
      q[field] = t.value;
    }
    renderPreview();
  };
  host.onclick = e => {
    const del = e.target.closest('[data-del-q]');
    if (del) {
      state.content.questions.splice(Number(del.dataset.delQ), 1);
      renderQuestionEditor(); renderPreview();
    }
  };
}

function renderPreview() {
  const c = state.content;
  const passageHtml = c.passages.map(p => `<section><h3>${esc(p.title)}</h3>${renderPassage(p.html, state.images)}</section>`).join('<hr>');
  const questionsHtml = c.questions.map(q => {
    const opts = (q.options || []).map(o => `<div>${esc(o)}</div>`).join('');
    return `<div style="margin-bottom:14px"><strong>${q.number}. ${esc(q.prompt)}</strong>
      <div class="small muted">${esc(TYPE_LABELS[q.type] || q.type)}</div>
      ${q.context ? `<div class="small">${esc(q.context)}</div>` : ''}
      <div class="small">${opts}</div>
      <div class="small" style="color:var(--green)">正确答案：${esc((q.answer || []).join(' / ') || '未设置')}</div></div>`;
  }).join('');
  document.getElementById('contentPreview').innerHTML = `${passageHtml || '<p class="muted">暂无文章</p>'}<hr><h3>Questions</h3>${questionsHtml || '<p class="muted">暂无题目</p>'}`;
}

function setStatus(text, progress = null) {
  document.getElementById('parseStatus').textContent = text;
  if (progress !== null) document.getElementById('parseProgress').style.width = `${progress}%`;
}

async function parsePdf() {
  const file = document.getElementById('pdfFile').files[0];
  if (!file) return toast('请先选择 PDF 文件', true);
  try {
    setStatus('正在浏览器内解析 PDF…', 8);
    const pdfjsLib = await import('/vendor/pdf.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    const images = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const textContent = await page.getTextContent();
      const lineMap = new Map();
      for (const item of textContent.items) {
        if (!item.str?.trim()) continue;
        const y = Math.round(item.transform[5] / 4) * 4;
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y).push({ x: item.transform[4], text: item.str });
      }
      const lines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]).map(([y, items]) => ({
        y, text: items.sort((a, b) => a.x - b.x).map(i => i.text).join(' ')
      }));
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pageImage = canvas.toDataURL('image/jpeg', 0.72);

      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length && images.length < 20; i++) {
        const fn = ops.fnArray[i];
        const isImage = [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject, pdfjsLib.OPS.paintInlineImageXObject].includes(fn);
        if (!isImage) continue;
        const args = ops.argsArray[i];
        const transform = Array.isArray(args?.[1]) ? args[1] : Array.isArray(args?.[args.length - 1]) ? args[args.length - 1] : null;
        if (!transform || transform.length < 6) continue;
        const rect = transformToRect(transform, page, 2, canvas.width, canvas.height);
        if (rect.w < 18 || rect.h < 18) continue;
        const crop = document.createElement('canvas');
        crop.width = Math.min(1200, Math.max(1, Math.round(rect.w)));
        crop.height = Math.min(1200, Math.max(1, Math.round(rect.h)));
        crop.getContext('2d').drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, crop.width, crop.height);
        const near = lines.reduce((best, line) => {
          const distance = Math.abs(line.y - ((rect.y + rect.h / 2) / 2 + (page.view?.[1] || 0)));
          return !best || distance < best.distance ? { distance, text: line.text } : best;
        }, null);
        images.push({ index: images.length + 1, page: pageNo, dataUrl: crop.toDataURL('image/png'), nearText: near?.text || '', bbox: rect });
      }
      pages.push({ page: pageNo, text: lines.map(l => l.text).join('\n'), image: pageImage, images: images.filter(img => img.page === pageNo) });
      setStatus(`已解析第 ${pageNo}/${pdf.numPages} 页`, 8 + Math.round(pageNo / pdf.numPages * 42));
    }
    state.pages = pages;
    state.images = images;
    setStatus('正在调用 AI 识别文章与题目…', 55);
    let content;
    try {
      const result = await api('/api/ai/parse-pdf', {
        method: 'POST',
        body: JSON.stringify({ pages, fileName: file.name, testId: state.testId })
      });
      content = result.content;
      toast('AI 识别完成');
    } catch (e) {
      content = fallbackParse(pages, images);
      toast(`AI 识别失败，已使用简化解析：${e.message}`, true);
    }
    state.content = normalizeContent(content);
    state.content.images = state.images;
    insertImageMarkers(state.content, state.images);
    state.answers = Object.fromEntries(state.content.questions.map(q => [q.id, q.answer || []]));
    document.getElementById('paperTitle').value = state.content.title || '';
    document.getElementById('paperInstructions').value = state.content.instructions || '';
    renderPassageEditor(); renderQuestionEditor(); renderPreview();
    setStatus(`解析完成：${state.content.passages.length} 篇文章，${state.content.questions.length} 道题，${state.images.length} 张图片。请核实后保存。`, 100);
  } catch (e) {
    setStatus(`解析失败：${e.message}`, 0);
    toast(e.message, true);
  }
}

function transformToRect(m, page, scale, canvasW, canvasH) {
  const [a, b, c, d, e, f] = m;
  const points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const vx = page.view?.[0] || 0;
  const vyTop = page.view?.[3] || (canvasH / scale);
  const left = (x1 - vx) * scale;
  const right = (x2 - vx) * scale;
  const top = (vyTop - y2) * scale;
  const bottom = (vyTop - y1) * scale;
  const x = Math.max(0, Math.min(canvasW - 1, Math.round(left)));
  const y = Math.max(0, Math.min(canvasH - 1, Math.round(top)));
  return { x, y, w: Math.min(canvasW - x, Math.round(right - left)), h: Math.min(canvasH - y, Math.round(bottom - top)) };
}

function fallbackParse(pages, images) {
  const text = pages.map(p => p.text).join('\n');
  const split = text.search(/Questions\s+1\b/i);
  const articleText = split >= 0 ? text.slice(0, split) : text.slice(0, Math.floor(text.length * 0.65));
  const questionText = split >= 0 ? text.slice(split) : text.slice(Math.floor(text.length * 0.65));
  const paragraphs = articleText.split(/\n{2,}|\n(?=[A-Z])/).map(x => x.trim()).filter(Boolean).slice(0, 12);
  const html = paragraphs.map(p => `<p>${esc(p)}</p>`).join('\n');
  const qLines = questionText.split('\n').map(x => x.trim()).filter(x => /^\d+[\.\)]?\s+/.test(x)).slice(0, 40);
  const questions = qLines.map((line, i) => ({
    id: `q${i + 1}`, number: i + 1, type: 'completion', passageId: 'p1',
    prompt: line.replace(/^\d+[\.\)]?\s+/, ''), options: [], answer: []
  }));
  return {
    title: 'IELTS Academic Reading Test',
    instructions: 'Answer all questions. Write your answers in the boxes provided.',
    passages: [{ id: 'p1', title: 'Reading Passage 1', html }],
    sections: [], questions, images
  };
}

function insertImageMarkers(content, images) {
  if (!images.length || !content.passages.length) return;
  images.forEach((img, i) => {
    const marker = `[[IMAGE:${i + 1}]]`;
    const needle = String(img.nearText || '').trim().slice(0, 80);
    let placed = false;
    for (const p of content.passages) {
      if (needle && p.html.includes(needle)) {
        p.html = p.html.replace(needle, `${needle} ${marker}`);
        placed = true;
        break;
      }
    }
    if (!placed) content.passages[0].html += `\n<p>${marker}</p>`;
  });
}

async function generateAnswers() {
  try {
    setStatus('正在调用 AI 生成答案…', 70);
    const result = await api(`/api/tests/${state.testId}/generate-answers`, { method: 'POST', body: '{}' });
    state.answers = result.answers;
    state.content.questions.forEach(q => { q.answer = result.answers[q.id] || q.answer || []; });
    renderQuestionEditor(); renderPreview();
    toast('答案已生成，请逐题核实后保存');
    setStatus('AI 答案已生成，请核实并点击保存。', 100);
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveTest() {
  try {
    state.content.images = state.images;
    const answers = Object.fromEntries(state.content.questions.map(q => [q.id, q.answer || []]));
    await api(`/api/tests/${state.testId}`, {
      method: 'POST',
      body: JSON.stringify({ content: state.content, answers })
    });
    const data = await api('/api/bootstrap');
    state.volumes = data.volumes;
    renderTestPicker();
    toast('已保存到当前 Test');
  } catch (e) { toast(e.message, true); }
}

async function loadStudents() {
  try {
    const data = await api('/api/students');
    document.getElementById('studentTable').innerHTML = data.students.map(s => `
      <tr><td>${esc(s.name)}</td><td>${esc(s.username)}</td><td class="small muted">${fmtDate(s.created_at)}</td>
      <td><button class="btn sm" data-edit="${s.id}">修改</button> <button class="btn sm danger" data-del="${s.id}">删除</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无学生</td></tr>';
    document.getElementById('studentTable').onclick = e => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (edit) openStudentModal(data.students.find(s => s.id === Number(edit.dataset.edit)));
      if (del) deleteStudent(Number(del.dataset.del));
    };
  } catch (e) { toast(e.message, true); }
}

function openStudentModal(student = null) {
  const modal = document.getElementById('studentModal');
  modal.innerHTML = `<div class="modal">
    <h2>${student ? '修改学生账号' : '新建学生账号'}</h2>
    <label class="field"><span>姓名</span><input class="input" id="stuName" value="${esc(student?.name || '')}"></label>
    <label class="field"><span>账号</span><input class="input" id="stuUser" value="${esc(student?.username || '')}"></label>
    <label class="field"><span>${student ? '新密码（留空则不修改）' : '密码'}</span><input class="input" id="stuPwd" type="password"></label>
    <div class="modal-actions"><button class="btn" id="cancelStu">取消</button><button class="btn primary" id="okStu">保存</button></div>
  </div>`;
  modal.classList.add('show');
  document.getElementById('cancelStu').onclick = () => modal.classList.remove('show');
  document.getElementById('okStu').onclick = async () => {
    const payload = {
      name: document.getElementById('stuName').value.trim(),
      username: document.getElementById('stuUser').value.trim(),
      password: document.getElementById('stuPwd').value
    };
    if (!payload.name || !payload.username || (!student && !payload.password)) return toast('请填写完整信息', true);
    try {
      await api(student ? `/api/students/${student.id}` : '/api/students', {
        method: student ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      modal.classList.remove('show');
      await loadStudents();
      toast('学生账号已保存');
    } catch (e) { toast(e.message, true); }
  };
}

async function deleteStudent(id) {
  if (!confirm('确定删除这个学生账号吗？其答卷记录也会一并删除。')) return;
  try {
    await api(`/api/students/${id}`, { method: 'DELETE' });
    await loadStudents();
    toast('已删除');
  } catch (e) { toast(e.message, true); }
}

async function loadAiConfig() {
  try {
    const config = await api('/api/ai/config');
    document.getElementById('aiBaseUrl').value = config.baseUrl || '';
    document.getElementById('aiModel').value = config.model || '';
    document.getElementById('aiVisionModel').value = config.visionModel || '';
    document.getElementById('aiStatus').textContent = config.apiKeySet ? 'API Key 已配置' : '尚未配置 API Key';
  } catch (e) { toast(e.message, true); }
}

async function saveAiConfig() {
  try {
    const payload = {
      baseUrl: document.getElementById('aiBaseUrl').value.trim(),
      apiKey: document.getElementById('aiKey').value.trim(),
      model: document.getElementById('aiModel').value.trim(),
      visionModel: document.getElementById('aiVisionModel').value.trim()
    };
    const result = await api('/api/ai/config', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('aiKey').value = '';
    document.getElementById('aiStatus').textContent = result.apiKeySet ? 'AI 设置已保存' : '设置已保存，但尚未配置 API Key';
    toast('AI 设置已保存');
  } catch (e) { toast(e.message, true); }
}

function openAdminPwdModal() {
  const modal = document.getElementById('adminPwdModal');
  modal.innerHTML = `<div class="modal">
    <h2>修改管理员密码</h2>
    <label class="field"><span>新密码</span><input class="input" id="newAdminPwd" type="password"></label>
    <div class="modal-actions"><button class="btn" id="cancelPwd">取消</button><button class="btn primary" id="okPwd">保存</button></div>
  </div>`;
  modal.classList.add('show');
  document.getElementById('cancelPwd').onclick = () => modal.classList.remove('show');
  document.getElementById('okPwd').onclick = async () => {
    const value = document.getElementById('newAdminPwd').value;
    if (value.length < 4) return toast('密码至少 4 位', true);
    try {
      await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ newPassword: value }) });
      modal.classList.remove('show');
      toast('管理员密码已修改');
    } catch (e) { toast(e.message, true); }
  };
}

adminReady(init);
