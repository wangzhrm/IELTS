import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'data', 'ielts.db');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 80 * 1024 * 1024;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT,
  answers_json TEXT,
  updated_at TEXT,
  UNIQUE(volume_id, number)
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  ref_id INTEGER,
  test_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  score INTEGER,
  band REAL,
  published INTEGER NOT NULL DEFAULT 0,
  report_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_test ON attempts(test_id, submitted_at);
`);

const now = () => new Date().toISOString();
const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch { return false; }
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function seed() {
  if (!getSetting('admin_password_hash')) {
    setSetting('admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || 'admin123'));
  }
  if (!getSetting('ai_config')) {
    setSetting('ai_config', JSON.stringify({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      visionModel: 'gpt-4o'
    }));
  }
  const volumeCount = db.prepare('SELECT COUNT(*) AS c FROM volumes').get().c;
  if (volumeCount === 0) {
    const insertVolume = db.prepare('INSERT INTO volumes(id, number, title) VALUES(?, ?, ?)');
    const insertTest = db.prepare('INSERT INTO tests(volume_id, number, title, updated_at) VALUES(?, ?, ?, ?)');
    for (let v = 1; v <= 21; v++) {
      insertVolume.run(v, v, `Volume ${v}`);
      for (let t = 1; t <= 4; t++) {
        insertTest.run(v, t, `Test ${t}`, now());
      }
    }
  }
  if (!db.prepare("SELECT 1 FROM tests WHERE id = (SELECT id FROM tests WHERE volume_id=1 AND number=1) AND content_json IS NOT NULL").get()) {
    const demoContent = {
      title: 'IELTS Reading — Sample Test',
      timeLimitMinutes: 60,
      instructions: 'You should spend about 20 minutes on each passage. Answer all questions and transfer your answers before the time limit.',
      passages: [{
        id: 'p1',
        title: 'Reading Passage 1',
        page: 1,
        html: `<h3>The Rise of Urban Green Spaces</h3>
<p>Urban green spaces have become a central feature of modern city planning. Once treated as decorative extras, parks and community gardens are now recognised as essential infrastructure. City planners argue that access to greenery improves physical health, reduces stress and creates opportunities for social contact among residents who might otherwise never meet.</p>
<p>The expansion of green space is not without challenges. Land in dense city centres is expensive, and maintaining parks requires long-term funding. Nevertheless, several cities have reported measurable benefits. A study of twelve European cities found that neighbourhoods with more tree cover experienced lower summer temperatures and fewer heat-related illnesses.</p>
<p>Community gardens have proved especially valuable. They provide fresh produce in areas where supermarkets are scarce, and they give participants a sense of control over their local environment. Schools increasingly use such gardens for outdoor lessons, linking science and nutrition to everyday experience.</p>`
      }],
      sections: [
        { id: 's1', passageId: 'p1', instruction: 'Questions 1–4', questionIds: ['q1', 'q2', 'q3', 'q4'] },
        { id: 's2', passageId: 'p1', instruction: 'Questions 5–8', questionIds: ['q5', 'q6', 'q7', 'q8'] }
      ],
      questions: [
        { id: 'q1', number: 1, type: 'mcq', passageId: 'p1', prompt: 'According to the passage, how were urban green spaces viewed in the past?', options: ['A  As unnecessary luxuries', 'B  As purely decorative additions', 'C  As dangerous public areas', 'D  As commercial centres'], answer: ['B'] },
        { id: 'q2', number: 2, type: 'tfng', passageId: 'p1', prompt: 'Green spaces can help people from different backgrounds meet each other.', options: ['True', 'False', 'Not Given'], answer: ['True'] },
        { id: 'q3', number: 3, type: 'tfng', passageId: 'p1', prompt: 'The cost of land is the only obstacle to creating new parks.', options: ['True', 'False', 'Not Given'], answer: ['False'] },
        { id: 'q4', number: 4, type: 'tfng', passageId: 'p1', prompt: 'The author has personally worked in a community garden.', options: ['True', 'False', 'Not Given'], answer: ['Not Given'] },
        { id: 'q5', number: 5, type: 'matching', passageId: 'p1', context: 'Choose the correct heading for Paragraph 2.', prompt: 'Paragraph 2', options: ['A  A successful solution to urban heat', 'B  Why city gardens are unpopular', 'C  Obstacles and evidence of benefit', 'D  New ways to train teachers'], answer: ['C'] },
        { id: 'q6', number: 6, type: 'completion', passageId: 'p1', context: 'Complete the sentence below. Write NO MORE THAN TWO WORDS from the passage.', prompt: 'Community gardens can improve residents’ sense of control over their ______.', wordLimit: 2, answer: ['local environment'] },
        { id: 'q7', number: 7, type: 'matching', passageId: 'p1', context: 'Match each use with the part of the passage where it is mentioned.', prompt: 'Outdoor lessons for science and nutrition', options: ['A  Paragraph 1', 'B  Paragraph 2', 'C  Paragraph 3'], answer: ['C'] },
        { id: 'q8', number: 8, type: 'multiple', passageId: 'p1', prompt: 'Which TWO benefits of community gardens are mentioned?', options: ['A  Lower summer temperatures', 'B  Fresh food in areas with few shops', 'C  A feeling of control', 'D  Reduced traffic congestion'], maxAnswers: 2, answer: ['B', 'C'] }
      ],
      images: []
    };
    const testId = db.prepare('SELECT id FROM tests WHERE volume_id=1 AND number=1').get().id;
    db.prepare('UPDATE tests SET content_json=?, answers_json=?, updated_at=? WHERE id=?').run(
      JSON.stringify(demoContent),
      JSON.stringify(Object.fromEntries(demoContent.questions.map(q => [q.id, q.answer]))),
      now(), testId
    );
  }
  if (!db.prepare('SELECT 1 FROM students LIMIT 1').get()) {
    db.prepare('INSERT INTO students(username, name, password_hash, created_at) VALUES(?,?,?,?)')
      .run('student1', 'Demo Student', hashPassword('study123'), now());
  }
  const studentId = db.prepare('SELECT id FROM students WHERE username=?').get('student1').id;
  const testId = db.prepare('SELECT id FROM tests WHERE volume_id=1 AND number=1').get().id;
  if (!db.prepare('SELECT 1 FROM attempts WHERE student_id=? AND test_id=?').get(studentId, testId)) {
    const demoAnswers = { q1: 'B', q2: 'False', q3: 'False', q4: 'Not Given', q5: 'C', q6: 'local environment', q7: 'A', q8: ['B', 'D'] };
    const submitted = new Date(Date.now() - 86400000).toISOString();
    db.prepare(`INSERT INTO attempts(test_id, student_id, answers_json, started_at, deadline_at, submitted_at, published, report_json)
      VALUES(?,?,?,?,?,?,0,?)`).run(
        testId, studentId, JSON.stringify(demoAnswers),
        new Date(Date.parse(submitted) - 3600000).toISOString(), submitted, submitted, null
      );
  }
}
seed();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function tokenFrom(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') || '';
}

function sessionFrom(req, role) {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token=? AND role=?').get(token, role);
  return row || null;
}

function requireAdmin(req, res) {
  const session = sessionFrom(req, 'admin');
  if (!session) {
    sendJson(res, 401, { error: '请先登录老师端' });
    return null;
  }
  return session;
}

function requireStudent(req, res) {
  const session = sessionFrom(req, 'student');
  if (!session) {
    sendJson(res, 401, { error: '请先登录学生账号' });
    return null;
  }
  return session;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function aiConfig() {
  return parseJson(getSetting('ai_config'), {});
}

function normalizeAnswer(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim().toLowerCase().replace(/[.,;:!?"'“”‘’]/g, '')).sort();
  return String(value ?? '').trim().toLowerCase().replace(/[.,;:!?"'“”‘’]/g, '').replace(/\s+/g, ' ');
}

function answersEqual(question, studentValue, correctValue) {
  if (correctValue === undefined || correctValue === null || correctValue === '') return false;
  if (Array.isArray(correctValue) || Array.isArray(studentValue)) {
    const a = normalizeAnswer(studentValue);
    const b = normalizeAnswer(correctValue);
    const arrA = Array.isArray(a) ? a : [a];
    const arrB = Array.isArray(b) ? b : [b];
    return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
  }
  const accept = String(correctValue).split('|').map(normalizeAnswer);
  const student = normalizeAnswer(studentValue);
  if (accept.includes(student)) return true;
  const withoutArticle = student.replace(/^(a|an|the)\s+/, '');
  return accept.some(a => a.replace(/^(a|an|the)\s+/, '') === withoutArticle);
}

function bandFor(score, total) {
  if (!total) return 0;
  const scaled = Math.round((score / total) * 40);
  const table = [
    [39, 9.0], [37, 8.5], [35, 8.0], [33, 7.5], [30, 7.0], [27, 6.5],
    [23, 6.0], [19, 5.5], [15, 5.0], [13, 4.5], [10, 4.0], [8, 3.5],
    [6, 3.0], [4, 2.5], [2, 2.0], [1, 1.0], [0, 0]
  ];
  return table.find(([min]) => scaled >= min)[1];
}

async function callAI(messages, { model, maxTokens = 6000, temperature = 0.2 } = {}) {
  const config = aiConfig();
  if (!config.apiKey) throw new Error('尚未配置 AI API Key，请在老师端「AI 设置」中填写。');
  const endpoint = String(config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
  const payload = {
    model: model || config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  };
  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    }
  };
  let response = await fetch(url, { ...fetchOptions, body: JSON.stringify(payload) });
  if (response.status === 400) {
    delete payload.response_format;
    response = await fetch(url, { ...fetchOptions, body: JSON.stringify(payload) });
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`AI 请求失败 (${response.status}): ${text.slice(0, 400)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('AI 返回内容不是有效 JSON'); }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');
  let cleaned = String(content).trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { throw new Error('AI 返回的 JSON 无法解析：' + cleaned.slice(0, 300)); }
}

function testRow(id) {
  return db.prepare(`SELECT t.*, v.number AS volume_number
    FROM tests t JOIN volumes v ON v.id=t.volume_id WHERE t.id=?`).get(id);
}

function testSummary(row) {
  if (!row) return null;
  const content = parseJson(row.content_json);
  return {
    id: row.id,
    volumeId: row.volume_id,
    volume: row.volume_number,
    number: row.number,
    title: row.title,
    hasContent: !!content,
    questionCount: content?.questions?.length || 0,
    updatedAt: row.updated_at,
    hasAnswers: !!row.answers_json
  };
}

function validateContent(content) {
  if (!content || typeof content !== 'object') throw new Error('题库内容格式不正确');
  if (!Array.isArray(content.passages)) throw new Error('缺少 passages');
  if (!Array.isArray(content.questions)) throw new Error('缺少 questions');
  content.instructions ||= 'You should spend about 20 minutes on each passage.';
  content.timeLimitMinutes = 60;
  content.images ||= [];
  content.sections ||= [];
  content.questions.forEach((q, i) => {
    q.id ||= `q${i + 1}`;
    q.number = Number(q.number) || i + 1;
    q.type ||= 'completion';
    q.prompt ||= '';
    q.passageId ||= content.passages[0]?.id || 'p1';
    q.options = Array.isArray(q.options) ? q.options : [];
    q.answer = Array.isArray(q.answer) ? q.answer : (q.answer ? [q.answer] : []);
    q.wordLimit = q.wordLimit ? Number(q.wordLimit) : null;
    q.maxAnswers = q.maxAnswers ? Number(q.maxAnswers) : null;
  });
  return content;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
  let filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!fs.existsSync(filePath) && rel.startsWith('/vendor/')) {
    const fromNodeModules = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', path.basename(rel));
    if (fs.existsSync(fromNodeModules)) filePath = fromNodeModules;
  }
  if (!filePath.startsWith(PUBLIC_DIR) && !filePath.includes(`${path.sep}node_modules${path.sep}`)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/bootstrap' && method === 'GET') {
    const volumes = db.prepare('SELECT * FROM volumes ORDER BY number').all().map(v => ({
      id: v.id,
      number: v.number,
      title: v.title,
      tests: db.prepare('SELECT * FROM tests WHERE volume_id=? ORDER BY number').all(v.id).map(testSummary)
    }));
    return sendJson(res, 200, { volumes, defaultStudent: { username: 'student1', password: 'study123' } });
  }

  if (p === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    if (!verifyPassword(body.password || '', getSetting('admin_password_hash'))) {
      return sendJson(res, 401, { error: '管理员密码错误' });
    }
    const token = newToken();
    db.prepare('INSERT INTO sessions(token, role, created_at) VALUES(?,?,?)').run(token, 'admin', now());
    return sendJson(res, 200, { token });
  }

  if (p === '/api/admin/password' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (!body.newPassword || String(body.newPassword).length < 4) return sendJson(res, 400, { error: '新密码至少 4 位' });
    setSetting('admin_password_hash', hashPassword(body.newPassword));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/ai/config' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const config = aiConfig();
    return sendJson(res, 200, { ...config, apiKeySet: !!config.apiKey });
  }

  if (p === '/api/ai/config' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const current = aiConfig();
    const next = {
      baseUrl: body.baseUrl || current.baseUrl || 'https://api.openai.com/v1',
      apiKey: body.apiKey ? body.apiKey : current.apiKey,
      model: body.model || current.model || 'gpt-4o-mini',
      visionModel: body.visionModel || current.visionModel || 'gpt-4o'
    };
    setSetting('ai_config', JSON.stringify(next));
    return sendJson(res, 200, { ok: true, ...next, apiKeySet: !!next.apiKey });
  }

  if (p === '/api/students' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare('SELECT id, username, name, created_at FROM students ORDER BY created_at DESC').all();
    return sendJson(res, 200, { students: rows });
  }

  if (p === '/api/students' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (!body.username || !body.name || !body.password) return sendJson(res, 400, { error: '账号、姓名和密码都不能为空' });
    try {
      const result = db.prepare('INSERT INTO students(username, name, password_hash, created_at) VALUES(?,?,?,?)')
        .run(String(body.username).trim(), String(body.name).trim(), hashPassword(body.password), now());
      return sendJson(res, 200, { id: Number(result.lastInsertRowid) });
    } catch (e) {
      return sendJson(res, 400, { error: '账号已存在或输入不合法' });
    }
  }

  let match = p.match(/^\/api\/students\/(\d+)$/);
  if (match && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    const body = await readBody(req);
    const student = db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (!student) return sendJson(res, 404, { error: '学生不存在' });
    try {
      if (body.password) {
        db.prepare('UPDATE students SET username=?, name=?, password_hash=? WHERE id=?')
          .run(String(body.username || student.username).trim(), String(body.name || student.name).trim(), hashPassword(body.password), id);
      } else {
        db.prepare('UPDATE students SET username=?, name=? WHERE id=?')
          .run(String(body.username || student.username).trim(), String(body.name || student.name).trim(), id);
      }
      return sendJson(res, 200, { ok: true });
    } catch { return sendJson(res, 400, { error: '账号已存在或输入不合法' }); }
  }
  if (match && method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    if (id === 1 && db.prepare('SELECT COUNT(*) c FROM students').get().c === 1) return sendJson(res, 400, { error: '至少保留一个学生账号' });
    db.prepare('DELETE FROM sessions WHERE role=? AND ref_id=?').run('student', id);
    db.prepare('DELETE FROM students WHERE id=?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  match = p.match(/^\/api\/tests\/(\d+)$/);
  if (match && method === 'GET') {
    const row = testRow(Number(match[1]));
    if (!row) return sendJson(res, 404, { error: 'Test 不存在' });
    return sendJson(res, 200, {
      ...testSummary(row),
      content: parseJson(row.content_json),
      answers: parseJson(row.answers_json, {})
    });
  }
  if (match && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    const row = testRow(id);
    if (!row) return sendJson(res, 404, { error: 'Test 不存在' });
    const body = await readBody(req);
    const content = validateContent(body.content);
    const answers = body.answers || Object.fromEntries(content.questions.map(q => [q.id, q.answer]));
    db.prepare('UPDATE tests SET content_json=?, answers_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(content), JSON.stringify(answers), now(), id);
    return sendJson(res, 200, { ok: true });
  }

  match = p.match(/^\/api\/tests\/(\d+)\/generate-answers$/);
  if (match && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const row = testRow(Number(match[1]));
    if (!row) return sendJson(res, 404, { error: 'Test 不存在' });
    const content = parseJson(row.content_json);
    if (!content) return sendJson(res, 400, { error: '请先保存题目内容' });
    const questions = content.questions.map(q => ({
      id: q.id, number: q.number, type: q.type, prompt: q.prompt,
      context: q.context || '', options: q.options || [], wordLimit: q.wordLimit || null
    }));
    const passages = (content.passages || []).map(x => ({ id: x.id, title: x.title, html: x.html }));
    const result = await callAI([
      { role: 'system', content: '你是严谨的雅思阅读出题与答案审核专家。根据文章和题目给出每题正确答案。只输出 JSON。' },
      { role: 'user', content: `文章：\n${JSON.stringify(passages).slice(0, 40000)}\n\n题目：\n${JSON.stringify(questions).slice(0, 40000)}\n\n请输出 JSON：{"answers":{"题目ID":答案}}。单选题答案为字符串；多选题答案为字符串数组；填空题答案尽可能使用文章原文，多个可接受答案用 | 分隔。` }
    ], { maxTokens: 4000 });
    if (!result.answers || typeof result.answers !== 'object') throw new Error('AI 未返回 answers 字段');
    const answers = {};
    content.questions.forEach(q => {
      const value = result.answers[q.id];
      if (value !== undefined) answers[q.id] = Array.isArray(value) ? value : String(value);
    });
    return sendJson(res, 200, { answers });
  }

  if (p === '/api/ai/parse-pdf' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!pages.length) return sendJson(res, 400, { error: '没有收到 PDF 页面' });
    const config = aiConfig();
    const imageDescriptors = pages.flatMap(pg => (pg.images || []).map((img, i) => ({
      marker: `[[IMAGE:${img.index || i + 1}]]`,
      page: pg.page,
      position: img.position || {},
      nearText: img.nearText || ''
    })));
    const textPayload = pages.map(pg => `=== Page ${pg.page} ===\n${pg.text || ''}`).join('\n\n').slice(0, 80000);
    const userContent = [
      { type: 'text', text: `请从雅思阅读 PDF 中提取完整结构化题库。\n\n文字层：\n${textPayload}\n\n图片清单（必须在文章 HTML 中用对应 marker 原样插入到正确位置，且每个 marker 只使用一次）：\n${JSON.stringify(imageDescriptors)}\n\n请严格输出 JSON：\n{\n  "title":"试卷标题",\n  "instructions":"指导语",\n  "passages":[{"id":"p1","title":"Reading Passage 1","page":1,"html":"段落 HTML，插图处写 [[IMAGE:n]]"}],\n  "sections":[{"id":"s1","passageId":"p1","instruction":"Questions 1-5","questionIds":["q1"]}],\n  "questions":[{"id":"q1","number":1,"type":"mcq|multiple|tfng|ynng|matching|completion|short-answer|diagram","passageId":"p1","prompt":"题干","context":"共享说明/表格说明，可为空","options":["A ...","B ..."],"wordLimit":2,"maxAnswers":2,"answer":[]}],\n  "images":[]\n}\n题型规则：True/False/Not Given 用 tfng；Yes/No/Not Given 用 ynng；标题匹配、段落匹配、句子结尾匹配、人名匹配用 matching；摘要/笔记/图表/流程填空用 completion 或 diagram；简答题用 short-answer；单选 mcq；多选 multiple。每个空格/判断句/匹配项都必须是独立题目并有唯一 number。不要遗漏任何题目。` }
    ];
    if (config.visionModel) {
      for (const pg of pages.slice(0, 12)) {
        if (pg.image) userContent.push({ type: 'image_url', image_url: { url: String(pg.image).slice(0, 4000000), detail: 'high' } });
      }
    }
    const result = await callAI([
      { role: 'system', content: '你是 OCR 与雅思试题结构化专家。输出必须是可被 JSON.parse 解析的纯 JSON，不要 Markdown。' },
      { role: 'user', content: userContent }
    ], { model: config.visionModel || config.model, maxTokens: 20000, temperature: 0 });
    return sendJson(res, 200, { content: result });
  }

  if (p === '/api/exam/login' && method === 'POST') {
    const body = await readBody(req);
    const row = db.prepare('SELECT s.*, t.id AS test_id FROM students s, tests t WHERE s.username=? AND t.id=?')
      .get(String(body.username || '').trim(), Number(body.testId));
    if (!row || !verifyPassword(body.password || '', row.password_hash)) {
      return sendJson(res, 401, { error: '账号或密码错误' });
    }
    const token = newToken();
    db.prepare('INSERT INTO sessions(token, role, ref_id, test_id, created_at) VALUES(?,?,?,?,?)')
      .run(token, 'student', row.id, row.test_id, now());
    return sendJson(res, 200, { token, name: row.name });
  }

  if (p === '/api/exam/me' && method === 'GET') {
    const session = requireStudent(req, res);
    if (!session) return;
    const attempt = db.prepare(`SELECT * FROM attempts WHERE student_id=? AND test_id=?
      ORDER BY CASE WHEN submitted_at IS NULL THEN 0 ELSE 1 END, id DESC LIMIT 1`)
      .get(session.ref_id, session.test_id);
    if (!attempt) return sendJson(res, 200, { attempt: null });
    return sendJson(res, 200, {
      attempt: {
        id: attempt.id,
        status: attempt.submitted_at ? 'submitted' : 'in_progress',
        deadlineAt: attempt.deadline_at,
        submittedAt: attempt.submitted_at,
        answers: parseJson(attempt.answers_json, {}),
        published: !!attempt.published
      }
    });
  }

  if (p === '/api/exam/start' && method === 'POST') {
    const session = requireStudent(req, res);
    if (!session) return;
    const existing = db.prepare(`SELECT * FROM attempts WHERE student_id=? AND test_id=? AND submitted_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(session.ref_id, session.test_id);
    if (existing) {
      return sendJson(res, 200, { attemptId: existing.id, deadlineAt: existing.deadline_at, resumed: true });
    }
    const started = now();
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = db.prepare(`INSERT INTO attempts(test_id, student_id, answers_json, started_at, deadline_at)
      VALUES(?,?,?,?,?)`).run(session.test_id, session.ref_id, '{}', started, deadline);
    return sendJson(res, 200, { attemptId: Number(result.lastInsertRowid), deadlineAt: deadline, resumed: false });
  }

  if (p === '/api/exam/save' && method === 'POST') {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const attempt = db.prepare(`SELECT * FROM attempts WHERE student_id=? AND test_id=? AND submitted_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(session.ref_id, session.test_id);
    if (!attempt) return sendJson(res, 400, { error: '没有进行中的答卷' });
    if (new Date(attempt.deadline_at).getTime() < Date.now()) return sendJson(res, 400, { error: '考试时间已结束' });
    db.prepare('UPDATE attempts SET answers_json=? WHERE id=?').run(JSON.stringify(body.answers || {}), attempt.id);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/exam/submit' && method === 'POST') {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const attempt = db.prepare(`SELECT * FROM attempts WHERE student_id=? AND test_id=? AND submitted_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(session.ref_id, session.test_id);
    if (!attempt) return sendJson(res, 400, { error: '没有进行中的答卷' });
    const test = testRow(session.test_id);
    const content = parseJson(test?.content_json);
    const questions = content?.questions || [];
    const answers = body.answers || {};
    let correct = 0;
    const report = questions.map(q => {
      const choiceTypes = ['mcq', 'multiple', 'matching', 'tfng', 'ynng'];
      const correctValue = !choiceTypes.includes(q.type) && Array.isArray(q.answer) && q.answer.length === 1
        ? q.answer[0]
        : q.answer;
      const ok = answersEqual(q, answers[q.id], correctValue);
      if (ok) correct++;
      return { questionId: q.id, studentAnswer: answers[q.id] ?? '', correctAnswer: q.answer ?? [], correct: ok, decidedBy: 'auto' };
    });
    db.prepare(`UPDATE attempts SET answers_json=?, submitted_at=?, score=?, band=?, report_json=? WHERE id=?`)
      .run(JSON.stringify(answers), now(), correct, bandFor(correct, questions.length), JSON.stringify(report), attempt.id);
    return sendJson(res, 200, { ok: true, submittedAt: now() });
  }

  if (p === '/api/exam/result' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: '请输入姓名' });
    const rows = db.prepare(`SELECT a.*, t.volume_id, v.number AS volume, t.number AS test_number, s.name AS student_name
      FROM attempts a JOIN tests t ON t.id=a.test_id JOIN volumes v ON v.id=t.volume_id
      JOIN students s ON s.id=a.student_id
      WHERE s.name=? AND a.published=1 AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC`).all(name);
    const results = rows.map(r => {
      const test = testRow(r.test_id);
      const content = parseJson(test?.content_json);
      return {
        id: r.id,
        volume: r.volume,
        test: r.test_number,
        submittedAt: r.submitted_at,
        score: r.score,
        band: r.band,
        total: content?.questions?.length || 0,
        questions: (content?.questions || []).map(q => {
          const item = (parseJson(r.report_json, []) || []).find(x => x.questionId === q.id);
          return {
            number: q.number,
            prompt: q.prompt,
            studentAnswer: item?.studentAnswer ?? '',
            correctAnswer: item?.correctAnswer ?? q.answer ?? [],
            correct: !!item?.correct
          };
        })
      };
    });
    return sendJson(res, 200, { name, results });
  }

  if (p === '/api/student/history' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const name = url.searchParams.get('name') || '';
    if (!name) return sendJson(res, 200, { history: [] });
    const rows = db.prepare(`SELECT a.*, v.number AS volume, t.number AS test_number, s.name AS student_name
      FROM attempts a JOIN tests t ON t.id=a.test_id JOIN volumes v ON v.id=t.volume_id
      JOIN students s ON s.id=a.student_id
      WHERE s.name=? AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at ASC`).all(name);
    return sendJson(res, 200, {
      history: rows.map(r => ({
        id: r.id, volume: r.volume, test: r.test_number, submittedAt: r.submitted_at,
        score: r.score, band: r.band, published: !!r.published
      }))
    });
  }

  if (p === '/api/grading/attempts' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare(`SELECT a.*, s.name AS student_name, s.username, v.number AS volume, t.number AS test_number,
      (SELECT COUNT(*) FROM json_each(t.content_json, '$.questions')) AS total
      FROM attempts a JOIN tests t ON t.id=a.test_id JOIN volumes v ON v.id=t.volume_id
      JOIN students s ON s.id=a.student_id
      WHERE a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC LIMIT 200`).all();
    return sendJson(res, 200, { attempts: rows.map(r => ({
      id: r.id, studentName: r.student_name, username: r.username, volume: r.volume, test: r.test_number,
      submittedAt: r.submitted_at, score: r.score, band: r.band, published: !!r.published, total: r.total || 0
    })) });
  }

  match = p.match(/^\/api\/grading\/(\d+)$/);
  if (match && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    const attempt = db.prepare(`SELECT a.*, s.name AS student_name, v.number AS volume, t.number AS test_number
      FROM attempts a JOIN students s ON s.id=a.student_id JOIN tests t ON t.id=a.test_id
      JOIN volumes v ON v.id=t.volume_id WHERE a.id=?`).get(id);
    if (!attempt) return sendJson(res, 404, { error: '答卷不存在' });
    const test = testRow(attempt.test_id);
    return sendJson(res, 200, {
      attempt: {
        id: attempt.id, studentName: attempt.student_name, volume: attempt.volume, test: attempt.test_number,
        submittedAt: attempt.submitted_at, published: !!attempt.published,
        answers: parseJson(attempt.answers_json, {}),
        report: parseJson(attempt.report_json, []),
        score: attempt.score, band: attempt.band
      },
      content: parseJson(test?.content_json),
      answers: parseJson(test?.answers_json, {})
    });
  }
  if (match && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    const body = await readBody(req);
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
    if (!attempt) return sendJson(res, 404, { error: '答卷不存在' });
    const test = testRow(attempt.test_id);
    const content = parseJson(test?.content_json);
    const questions = content?.questions || [];
    const report = Array.isArray(body.report) ? body.report : [];
    const correctMap = new Map(report.map(r => [r.questionId, !!r.correct]));
    let score = 0;
    const finalReport = questions.map(q => {
      const correct = correctMap.has(q.id) ? correctMap.get(q.id) : false;
      if (correct) score++;
      const source = report.find(r => r.questionId === q.id) || {};
      return {
        questionId: q.id,
        studentAnswer: source.studentAnswer ?? parseJson(attempt.answers_json, {})[q.id] ?? '',
        correctAnswer: q.answer ?? [],
        correct,
        decidedBy: source.decidedBy || 'teacher'
      };
    });
    const band = bandFor(score, questions.length);
    db.prepare('UPDATE attempts SET score=?, band=?, report_json=?, published=? WHERE id=?')
      .run(score, band, JSON.stringify(finalReport), body.publish ? 1 : 0, id);
    return sendJson(res, 200, { ok: true, score, band, total: questions.length, published: !!body.publish });
  }

  match = p.match(/^\/api\/ai\/grade\/(\d+)$/);
  if (match && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const id = Number(match[1]);
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
    if (!attempt) return sendJson(res, 404, { error: '答卷不存在' });
    const test = testRow(attempt.test_id);
    const content = parseJson(test?.content_json);
    const questions = (content?.questions || []).map(q => ({
      id: q.id, number: q.number, type: q.type, prompt: q.prompt, options: q.options || [],
      correctAnswer: q.answer, wordLimit: q.wordLimit || null
    }));
    const studentAnswers = parseJson(attempt.answers_json, {});
    const result = await callAI([
      { role: 'system', content: '你是雅思阅读阅卷老师。请逐题判断学生答案是否正确，只输出 JSON。' },
      { role: 'user', content: `题目与标准答案：\n${JSON.stringify(questions).slice(0, 40000)}\n\n学生答案：\n${JSON.stringify(studentAnswers).slice(0, 20000)}\n\n输出格式：{"results":[{"questionId":"q1","correct":true,"note":""}]}。判断时允许同义表达、单复数和冠词差异；多选题必须完全匹配。` }
    ], { maxTokens: 4000 });
    if (!Array.isArray(result.results)) throw new Error('AI 未返回 results 字段');
    const auto = questions.map(q => {
      const found = result.results.find(r => r.questionId === q.id);
      return { questionId: q.id, correct: !!found?.correct, decidedBy: 'ai' };
    });
    return sendJson(res, 200, { results: auto });
  }

  return sendJson(res, 404, { error: 'API 不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message || '服务器错误' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`IELTS Reading Lab running at http://localhost:${PORT}`);
  console.log('Default admin password: admin123 (set ADMIN_PASSWORD env to override)');
});
