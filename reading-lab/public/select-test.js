import { api, esc, toast, fmtDate, showLogin } from './shared.js';

const state = { volumes: [], volumeId: 1 };

async function init() {
  const data = await api('/api/bootstrap', { headers: {} });
  state.volumes = data.volumes;
  renderVolumes();
  renderTests();
  document.getElementById('queryHistory').onclick = queryHistory;
  document.getElementById('studentName').onkeydown = e => { if (e.key === 'Enter') queryHistory(); };
}

function renderVolumes() {
  document.getElementById('volumes').innerHTML = state.volumes.map(v =>
    `<button class="chip ${v.id === state.volumeId ? 'active' : ''}" data-volume="${v.id}">Volume ${v.number}</button>`).join('');
  document.getElementById('volumes').onclick = e => {
    const btn = e.target.closest('[data-volume]');
    if (btn) { state.volumeId = Number(btn.dataset.volume); renderVolumes(); renderTests(); }
  };
}

function renderTests() {
  const volume = state.volumes.find(v => v.id === state.volumeId);
  document.getElementById('volumeTitle').textContent = volume?.title || '';
  const base = `${location.origin}/student.html?volume=${volume?.number || 1}&test=`;
  document.getElementById('tests').innerHTML = (volume?.tests || []).map(t => `
    <div class="test-card">
      <h3>Test ${t.number}</h3>
      <div class="small muted">${t.hasContent ? `${t.questionCount} 题 · 已保存` : '尚未上传题库'}</div>
      <div class="chip-row" style="margin-top:10px">
        <button class="btn sm primary" data-open="${t.number}" ${t.hasContent ? '' : 'disabled'}>打开答题页</button>
        <button class="btn sm" data-copy="${base}${t.number}" ${t.hasContent ? '' : 'disabled'}>复制学生链接</button>
      </div>
      <div class="link-box" id="link-${t.number}">${esc(base)}${t.number}</div>
    </div>`).join('');
  document.getElementById('tests').onclick = e => {
    const open = e.target.closest('[data-open]');
    const copy = e.target.closest('[data-copy]');
    if (open) window.open(`/student.html?volume=${volume.number}&test=${open.dataset.open}`, '_blank');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('链接已复制')).catch(() => toast('请手动复制下方链接'));
    }
  };
}

async function queryHistory() {
  const name = document.getElementById('studentName').value.trim();
  if (!name) return toast('请输入学生姓名', true);
  const load = async () => {
    const data = await api(`/api/student/history?name=${encodeURIComponent(name)}`);
    renderHistory(name, data.history);
  };
  if (!localStorage.getItem('ielts_token')) return showLogin(load, '老师登录后可查看学生成绩');
  try { await load(); }
  catch (e) {
    if (String(e.message).includes('登录')) showLogin(load, '老师登录后可查看学生成绩');
    else toast(e.message, true);
  }
}

function renderHistory(name, history) {
  const host = document.getElementById('history');
  host.innerHTML = `<h3>${esc(name)} 的做题记录（${history.length} 次）</h3>` + (history.length ? `
    <div class="timeline">${history.map(h => `
      <div class="timeline-item">
        <div class="panel" style="margin:0">
          <strong>Volume ${h.volume} · Test ${h.test}</strong>
          <div class="small muted">${fmtDate(h.submittedAt)}</div>
          <div style="margin-top:6px">答对 <strong>${h.score ?? '—'}</strong> 题 · 阅读分数 <strong>${h.band != null ? Number(h.band).toFixed(1) : '待批改'}</strong>
            ${h.published ? '<span class="chip" style="margin-left:8px;color:var(--green)">已发布</span>' : '<span class="chip" style="margin-left:8px">待批改</span>'}
          </div>
        </div>
      </div>`).join('')}</div>` : '<div class="notice">没有找到该学生的提交记录。</div>');
}

init();
