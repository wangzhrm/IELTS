const queryShareCode = new URLSearchParams(location.search).get('sharecode');
if (queryShareCode) localStorage.setItem('ielts_sharecode', queryShareCode);

export function withShareCode(url) {
  const code = queryShareCode || localStorage.getItem('ielts_sharecode');
  if (!code) return url;
  const u = new URL(url, location.href);
  if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', code);
  return /^(https?:)/i.test(url) ? u.href : u.pathname + u.search + u.hash;
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('#') || /^(https?:|mailto:|tel:|data:)/i.test(href)) return;
  const updated = withShareCode(href);
  if (updated !== href) link.setAttribute('href', updated);
});

export async function api(path, options = {}) {
  const token = localStorage.getItem('ielts_token');
  const headers = { ...(options.headers || {}) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

export function sanitizeHtml(html) {
  const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'HR', 'DIV', 'SPAN', 'IMG', 'SUP', 'SUB']);
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const clean = node => {
    [...node.children].forEach(child => {
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        return;
      }
      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const ok = (name === 'src' && child.tagName === 'IMG' && attr.value.startsWith('data:image/')) ||
          ['class', 'colspan', 'rowspan'].includes(name);
        if (!ok) child.removeAttribute(attr.name);
      });
      clean(child);
    });
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

export function renderPassage(html, images = []) {
  return sanitizeHtml(html).replace(/\[\[IMAGE:(\d+)\]\]/g, (_, n) => {
    const image = images[Number(n) - 1];
    if (!image) return '';
    return `<img src="${esc(image.dataUrl)}" alt="Passage image ${n}" style="max-width:100%;height:auto;border:1px solid #dce3ea;border-radius:6px;margin:12px 0">`;
  });
}

export function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function toast(message, error = false) {
  let el = document.getElementById('globalToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'globalToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

export function showLogin(onSuccess, title = '老师端登录') {
  let backdrop = document.getElementById('adminLoginModal');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'adminLoginModal';
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal">
      <h2>${esc(title)}</h2>
      <div class="notice">默认管理员密码为 <strong>admin123</strong>，可在「AI 设置」中修改。</div>
      <label class="field"><span>管理员密码</span><input class="input" id="adminPwd" type="password" placeholder="请输入管理员密码" autocomplete="current-password"></label>
      <div id="loginErr" class="notice error" style="display:none"></div>
      <div class="modal-actions"><button class="btn primary" id="loginBtn">登录</button></div>
    </div>`;
  backdrop.classList.add('show');
  const input = backdrop.querySelector('#adminPwd');
  const submit = async () => {
    try {
      const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: input.value }) });
      localStorage.setItem('ielts_token', data.token);
      backdrop.classList.remove('show');
      onSuccess?.();
    } catch (e) {
      const err = backdrop.querySelector('#loginErr');
      err.textContent = e.message;
      err.style.display = 'block';
    }
  };
  backdrop.querySelector('#loginBtn').onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  input.focus();
}

export function adminReady(callback) {
  if (localStorage.getItem('ielts_token')) {
    api('/api/ai/config').then(callback).catch(() => showLogin(callback));
  } else {
    showLogin(callback);
  }
}

export function answerText(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}
