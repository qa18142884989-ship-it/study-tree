'use strict';

/*
 * study-tree · 后端服务（多用户版）
 * 零依赖，只用 Node 内置模块，`node server.js` 即可启动。
 *
 * 功能一览：
 *   - 账号：注册/登录/登出（scrypt 加盐哈希 + httpOnly Cookie 会话）、昵称、头像
 *   - 学习树：能力/知识节点的增删改、点亮、周常任务重置、等级经验
 *   - 笔记：md/pdf/doc/docx/ppt/pptx/图片 的上传、阅读、下载（按账号隔离）
 *   - 蓝图：发布/导入/评分，可见性分 公开 / 仅好友 / 私人，市场 + 好友蓝图筛选
 *   - 社交：好友（申请-同意制）、访客模式、管理员后台、意见反馈
 *
 * 目录结构：
 *   data/users.json            账号表（scrypt 加盐，不存明文）
 *   data/sessions.json         登录会话
 *   data/users/<uid>/tree.json 每个用户自己的study-tree
 *   data/users/<uid>/notes/    每个用户自己的笔记文件
 *   data/blueprints.json       蓝图索引（所有人可见）
 *   data/blueprints/<id>/      蓝图快照 + 附件副本
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.TT_DATA_DIR ? path.resolve(process.env.TT_DATA_DIR) : path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_DIR = path.join(DATA_DIR, 'users');
const BP_FILE = path.join(DATA_DIR, 'blueprints.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const CHAT_FILE = path.join(DATA_DIR, 'chats.json');
const BP_DIR = path.join(DATA_DIR, 'blueprints');
const LEGACY_TREE = path.join(DATA_DIR, 'tree.json');
const LEGACY_NOTES = path.join(DATA_DIR, 'notes');

const START_PORT = Number(process.env.PORT || 5173);
const API_VERSION = 12;
// TT_PUBLIC=1：准备放到公网时打开。会启用严格安全头、Secure Cookie、HSTS、禁止被 iframe 嵌入
const PUBLIC_MODE = process.env.TT_PUBLIC === '1';
// 只允许这几个文件被静态访问；数据目录、源码、备份一律不对外
const STATIC_FILES = new Set(['/index.html', '/favicon.ico', '/robots.txt']);          // 前端会比对：低于这个值说明后台还是旧进程
const STARTED_AT = Date.now();
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 64 * 1024 * 1024;
/* 单棵树的数据规模上限：防止登录用户塞超大结构放大内存/磁盘 */
const MAX_ABILITIES = 3000;
const MAX_FILES = 6000;
const MAX_TASKS = 200;
const VERSION = 7;
const INITIAL_POINTS = 10;
const SESSION_DAYS = 30;

const DEFAULT_CATEGORIES = [
  { id: 'cat_art', name: '艺术' },
  { id: 'cat_sport', name: '运动' },
  { id: 'cat_study', name: '学习' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function defaultTree() {
  return {
    version: VERSION,
    categories: DEFAULT_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
    points: INITIAL_POINTS,
    abilities: [],
    files: [],
    exp: 0,
    tasks: [],
    week: { key: '' },
    /* 时间规划：把一周的空闲时间按转化率换成科技点 */
    timer: { rate: 50, courses: [], plans: [], spent: 0, bonus: 0, weekKey: '' }
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, code, message) {
  sendJson(res, code, { error: message });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeFileName(name) {
  let s = String(name || '').replace(/^.*[\\/]/, '');
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  s = s.replace(/^\.+/, '');
  if (!s) s = 'note.txt';
  if (s.length > 90) {
    const ext = path.extname(s).slice(0, 10);
    s = s.slice(0, 90 - ext.length) + ext;
  }
  return s;
}

function extMime(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/* 按文件串行化写盘：避免并发写同一个文件共用 .tmp 导致 rename 失败 / 互相覆盖 */
const writeQueues = new Map();

function writeJson(file, obj) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  });
  writeQueues.set(file, next);
  return next;
}

async function ensureDirs() {
  await fsp.mkdir(USERS_DIR, { recursive: true });
  await fsp.mkdir(BP_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* 账号与会话                                                          */
/* ------------------------------------------------------------------ */

let users = [];
let sessions = {};
let friends = [];
let feedback = [];
let chats = [];

async function loadAuth() {
  users = await readJson(USERS_FILE, []);
  sessions = await readJson(SESSIONS_FILE, {});
  friends = await readJson(FRIENDS_FILE, []);
  if (!Array.isArray(friends)) friends = [];
  feedback = await readJson(FEEDBACK_FILE, []);
  if (!Array.isArray(feedback)) feedback = [];
  chats = await readJson(CHAT_FILE, []);
  if (!Array.isArray(chats)) chats = [];

  // 保证系统里始终有一个管理员：没有就把最早注册的账号提升为管理员
  if (!users.some((u) => u.role === 'admin') && users.length) {
    const first = users.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    first.role = 'admin';
    await writeJson(USERS_FILE, users);
  }
  const now = Date.now();
  let dirty = false;
  Object.keys(sessions).forEach((t) => {
    if (!sessions[t] || sessions[t].exp < now) { delete sessions[t]; dirty = true; }
  });
  if (dirty) await writeJson(SESSIONS_FILE, sessions);
}

/* 异步哈希：scrypt 是 CPU 密集型，同步会阻塞事件循环（登录/注册/改密码时全站卡一下） */
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString('hex'));
    });
  });
}

function findUserByName(name) {
  const key = String(name || '').trim().toLowerCase();
  return users.find((u) => u.name.toLowerCase() === key) || null;
}

function displayNameOf(u) {
  if (!u) return '';
  const d = String(u.displayName || '').trim();
  return d || u.name;
}

/* 好友可见性：tree 图谱 / timer 时间安排 / bp 蓝图，默认都开放 */
function normalizePrivacy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    tree: p.tree !== false,
    timer: p.timer !== false,
    bp: p.bp !== false
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    displayName: displayNameOf(u),
    avatar: typeof u.avatar === 'string' && u.avatar ? u.avatar : '',
    createdAt: u.createdAt,
    role: u.role === 'admin' ? 'admin' : 'user',
    admin: u.role === 'admin',
    privacy: normalizePrivacy(u.privacy)
  };
}

function isAdmin(u) {
  return !!u && u.role === 'admin';
}

function adminOnly(res, u) {
  if (isAdmin(u)) return false;
  fail(res, 403, '只有管理员可以访问');
  return true;
}

function linkBetween(x, y) {
  return friends.find((f) => (f.a === x && f.b === y) || (f.a === y && f.b === x)) || null;
}

function areFriends(x, y) {
  const f = linkBetween(x, y);
  return !!f && f.status !== 'pending';
}

/* none | out（我发出待同意）| in（对方发来待我同意）| friend */
function relationOf(x, y) {
  const f = linkBetween(x, y);
  if (!f) return 'none';
  if (f.status === 'pending') return f.a === x ? 'out' : 'in';
  return 'friend';
}

function securityHeaders(req, res) {
  // 每次响应生成一次性 nonce，页面里的内联 <script> 会被打上同一个 nonce，
  // 这样 CSP 就不需要放开 script-src 'unsafe-inline'（XSS 缓解能力大幅提升）。
  const nonce = res._cspNonce || '';
  const https = PUBLIC_MODE || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'" + (nonce ? " 'nonce-" + nonce + "'" : '') + "; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-src 'self' blob:; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'" +
    (https ? "; frame-ancestors 'none'" : ''));
  if (https) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Frame-Options', 'DENY');
  }
}

function clientIp(req) {
  if (PUBLIC_MODE) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  const sock = req.socket || {};
  return String(sock.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/* 登录/注册限速：同一 IP 或同一账号 10 分钟内失败次数过多就临时锁住 */
const authHits = new Map();

/* 注册验证码暂存：id → { sum, exp } */
const regChallenges = new Map();

/* 校验并立即作废（一次性） */
function consumeChallenge(id, answer) {
  const key = String(id || '');
  const rec = regChallenges.get(key);
  if (!rec) return false;
  regChallenges.delete(key);
  if (rec.exp < Date.now()) return false;
  return String(answer == null ? '' : answer).trim() === String(rec.sum);
}

function hitsKey(key, limit, windowMs) {
  const now = Date.now();
  const rec = authHits.get(key);
  if (!rec || rec.resetAt < now) {
    authHits.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  rec.n += 1;
  if (rec.n > limit) {
    rec.blockUntil = rec.resetAt;
    return true;
  }
  return false;
}

function hitsBlocked(key) {
  const rec = authHits.get(key);
  if (!rec) return 0;
  if (rec.blockUntil && rec.blockUntil > Date.now()) return Math.ceil((rec.blockUntil - Date.now()) / 60000);
  return 0;
}

function clearHits(prefix) {
  Array.from(authHits.keys()).forEach((k) => { if (k.indexOf(prefix) === 0) authHits.delete(k); });
}

setInterval(() => {
  const now = Date.now();
  Array.from(authHits.keys()).forEach((k) => {
    const r = authHits.get(k);
    if (!r || r.resetAt < now) authHits.delete(k);
  });
}, 10 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = sessions[token];
  if (!s || s.exp < Date.now()) return null;
  return users.find((u) => u.id === s.uid) || null;
}

function issueSession(req, res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { uid: user.id, exp: Date.now() + SESSION_DAYS * 86400000, at: Date.now() };
  writeJson(SESSIONS_FILE, sessions).catch(() => {});
  const https = PUBLIC_MODE || String(req.headers['x-forwarded-proto'] || '') === 'https';
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` +
    (https ? '; Secure' : ''));
}

/* 清理过期会话，避免 sessions.json 无限膨胀 */
function pruneSessions() {
  const now = Date.now();
  let n = 0;
  Object.keys(sessions).forEach((t) => {
    const s = sessions[t];
    if (!s || !s.exp || s.exp < now) {
      delete sessions[t];
      n++;
    }
  });
  if (n) writeJson(SESSIONS_FILE, sessions).catch(() => {});
  return n;
}

function userDir(uid) {
  return path.join(USERS_DIR, uid);
}

function treePath(uid) {
  return path.join(userDir(uid), 'tree.json');
}

function notesDir(uid) {
  return path.join(userDir(uid), 'notes');
}

/* 节点描述照片单独放一个目录，和笔记附件分开 */
function photosDir(uid) {
  return path.join(userDir(uid), 'photos');
}

function photoPathFor(uid, storedAs) {
  const dir = photosDir(uid);
  const safe = safeFileName(storedAs);
  const full = path.join(dir, safe);
  if (path.dirname(full) !== dir) return null;
  return full;
}

/* ------------------------------------------------------------------ */
/* 树数据规范化                                                        */
/* ------------------------------------------------------------------ */

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const kind = raw.kind === 'group' ? 'group' : 'leaf';
  let cost = Number(raw.cost);
  if (!isFinite(cost) || cost < 1) cost = 1;
  const ox = Number(raw.ox), oy = Number(raw.oy);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : 'a' + crypto.randomBytes(4).toString('hex'),
    name: name.slice(0, 80),
    cost: kind === 'group' ? 0 : Math.floor(cost),
    unlocked: raw.unlocked === true,
    kind: kind,
    parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId.slice(0, 64) : null,
    prereqIds: (function () {
      const src = Array.isArray(raw.prereqIds) ? raw.prereqIds : (raw.prereqId ? [raw.prereqId] : []);
      const out = [];
      src.forEach((x) => {
        if (typeof x !== 'string' || !x) return;
        const v = x.slice(0, 64);
        if (out.indexOf(v) < 0) out.push(v);
      });
      return out.slice(0, 8);
    })(),
    categoryId: typeof raw.categoryId === 'string' && raw.categoryId ? raw.categoryId.slice(0, 64) : null,
    ox: isFinite(ox) ? Math.round(ox) : 0,
    oy: isFinite(oy) ? Math.round(oy) : 0,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 20000) : '',
    /* 节点描述照片：最多 3 张，文件在 data/users/<uid>/photos/ */
    photos: (Array.isArray(raw.photos) ? raw.photos : []).slice(0, 3).map((p) => {
      if (!p || typeof p !== 'object') return null;
      const nm = typeof p.name === 'string' ? p.name.trim().slice(0, 120) : '';
      const storedAs = typeof p.storedAs === 'string' ? safeFileName(p.storedAs) : '';
      if (!nm || !storedAs) return null;
      return {
        id: typeof p.id === 'string' && p.id ? p.id.slice(0, 64) : 'ph' + crypto.randomBytes(4).toString('hex'),
        name: nm,
        mime: typeof p.mime === 'string' && p.mime ? p.mime.slice(0, 120) : extMime(nm),
        size: isFinite(Number(p.size)) ? Math.max(0, Math.floor(Number(p.size))) : 0,
        storedAs: storedAs,
        createdAt: isFinite(Number(p.createdAt)) ? Math.floor(Number(p.createdAt)) : Date.now()
      };
    }).filter(Boolean)
  };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  let pts = Number(raw.points);
  if (!isFinite(pts) || pts < 1) pts = 1;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : newId('t'),
    name: name.slice(0, 60),
    points: Math.floor(pts),
    done: raw.done === true,
    doneAt: isFinite(Number(raw.doneAt)) ? Number(raw.doneAt) : 0
  };
}

function sanitizeTimer(raw) {
  const t = { rate: 50, courses: [], plans: [], spent: 0, bonus: 0, weekKey: '', weeks: {} };
  if (!raw || typeof raw !== 'object') return t;
  const rate = Number(raw.rate);
  t.rate = isFinite(rate) ? Math.max(0, Math.min(100, Math.round(rate))) : 50;
  const spent = Number(raw.spent), bonus = Number(raw.bonus);
  t.spent = isFinite(spent) && spent > 0 ? Math.round(spent * 10) / 10 : 0;
  t.bonus = isFinite(bonus) && bonus > 0 ? Math.round(bonus * 10) / 10 : 0;
  t.weekKey = typeof raw.weekKey === 'string' ? raw.weekKey.slice(0, 20) : '';

  function sanitizeCourse(c) {
    if (!c || typeof c !== 'object') return null;
    const day = Math.round(Number(c.day));
    const start = Math.round(Number(c.start)), end = Math.round(Number(c.end));
    if (!(day >= 1 && day <= 7) || !isFinite(start) || !isFinite(end) || end <= start) return null;
    return {
      id: typeof c.id === 'string' && c.id ? c.id.slice(0, 64) : newId('c'),
      day: day, start: start, end: end,
      title: String(c.title || '').trim().slice(0, 30) || '课程'
    };
  }
  function sanitizePlan(p) {
    if (!p || typeof p !== 'object') return null;
    const start = Math.round(Number(p.start)), end = Math.round(Number(p.end));
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    let days = (Array.isArray(p.days) ? p.days : [])
      .map((x) => Math.round(Number(x)))
      .filter((d) => d >= 1 && d <= 7);
    days = Array.from(new Set(days));
    if (!days.length) days = [1, 2, 3, 4, 5, 6, 7];
    return {
      id: typeof p.id === 'string' && p.id ? p.id.slice(0, 64) : newId('p'),
      days: days, start: start, end: end,
      title: String(p.title || '').trim().slice(0, 30) || '安排'
    };
  }
  function sanitizeSchedule(obj) {
    const seenC = new Set(), seenP = new Set();
    const courses = (Array.isArray(obj && obj.courses) ? obj.courses : []).map(sanitizeCourse).filter((c) => {
      if (!c) return false;
      const k = c.day + '|' + c.start + '|' + c.end + '|' + c.title;
      if (seenC.has(k)) return false;
      seenC.add(k);
      return true;
    });
    const plans = (Array.isArray(obj && obj.plans) ? obj.plans : []).map(sanitizePlan).filter((p) => {
      if (!p) return false;
      const k = p.days.slice().sort().join(',') + '|' + p.start + '|' + p.end + '|' + p.title;
      if (seenP.has(k)) return false;
      seenP.add(k);
      return true;
    });
    return { courses, plans };
  }

  // 按周存储的课表（只保留最近 ~一年内的周，防止无限增长）
  if (raw.weeks && typeof raw.weeks === 'object') {
    const keys = Object.keys(raw.weeks).filter((k) => /^\d{4}W\d{2}$/.test(k)).sort();
    keys.slice(-80).forEach((k) => { t.weeks[k] = sanitizeSchedule(raw.weeks[k]); });
  }

  // 旧结构兼容：顶层 courses/plans 保留（客户端会迁移）
  (Array.isArray(raw.courses) ? raw.courses : []).forEach((c) => {
    const clean = sanitizeCourse(c);
    if (clean) t.courses.push(clean);
  });
  (Array.isArray(raw.plans) ? raw.plans : []).forEach((p) => {
    const clean = sanitizePlan(p);
    if (clean) t.plans.push(clean);
  });

  return t;
}

function sanitizeTree(raw) {
  const tree = defaultTree();
  if (!raw || typeof raw !== 'object') return tree;

  const cats = [];
  const seenCat = new Set();
  DEFAULT_CATEGORIES.forEach((c) => { cats.push({ id: c.id, name: c.name }); seenCat.add(c.id); });
  (Array.isArray(raw.categories) ? raw.categories : []).forEach((c) => {
    if (!c || typeof c !== 'object') return;
    const id = typeof c.id === 'string' && c.id ? c.id.slice(0, 64) : null;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '';
    if (!id || !name || seenCat.has(id)) return;
    seenCat.add(id);
    cats.push({ id: id, name: name });
  });
  tree.categories = cats;
  const catIds = new Set(cats.map((c) => c.id));

  const pts = Number(raw.points);
  tree.points = isFinite(pts) && pts >= 0 ? Math.round(pts * 10) / 10 : INITIAL_POINTS;

  const seen = new Set();
  const list = [];
  (Array.isArray(raw.abilities) ? raw.abilities : []).forEach((item) => {
    const node = normalizeNode(item);
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    list.push(node);
  });
  if (list.length > MAX_ABILITIES) list.length = MAX_ABILITIES;

  const groupIds = new Set(list.filter((a) => a.kind === 'group').map((a) => a.id));
  list.forEach((a) => {
    if (a.kind === 'group') a.parentId = null;
    else if (a.parentId && !groupIds.has(a.parentId)) a.parentId = null;
    if (!a.parentId) {
      if (!a.categoryId || !catIds.has(a.categoryId)) a.categoryId = DEFAULT_CATEGORIES[2].id;
    } else {
      a.categoryId = null;
    }
  });
  tree.abilities = list;

  const nodeById = new Map(list.map((a) => [a.id, a]));
  list.forEach((a) => {
    a.prereqIds = (a.prereqIds || []).filter((id) => {
      const p = nodeById.get(id);
      return !!p && p.kind !== 'group' && p.id !== a.id && (p.parentId || '') === (a.parentId || '');
    });
  });
  /* 断环：某个前置顺着链条能回到自己，就把这条前置去掉 */
  list.forEach((a) => {
    a.prereqIds = a.prereqIds.filter((pid) => {
      const seen = new Set();
      const stack = [pid];
      while (stack.length) {
        const cur = stack.pop();
        if (cur === a.id) return false;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const n = nodeById.get(cur);
        if (n && Array.isArray(n.prereqIds)) n.prereqIds.forEach((x) => stack.push(x));
      }
      return true;
    });
  });

  const files = [];
  const fileIds = new Set();
  (Array.isArray(raw.files) ? raw.files : []).forEach((f) => {
    if (!f || typeof f !== 'object') return;
    const id = typeof f.id === 'string' && f.id ? f.id.slice(0, 64) : newId('f');
    if (fileIds.has(id)) return;
    const nodeId = typeof f.nodeId === 'string' ? f.nodeId : '';
    if (!nodeId || !seen.has(nodeId)) return;
    const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 160) : '';
    if (!name) return;
    fileIds.add(id);
    const isLocal = f.local === true;
    files.push({
      id: id,
      nodeId: nodeId,
      name: name,
      mime: typeof f.mime === 'string' && f.mime ? f.mime.slice(0, 120) : extMime(name),
      size: isFinite(Number(f.size)) ? Math.max(0, Math.floor(Number(f.size))) : 0,
      storedAs: isLocal ? '' : (typeof f.storedAs === 'string' ? safeFileName(f.storedAs) : ''),
      local: isLocal,
      createdAt: isFinite(Number(f.createdAt)) ? Math.floor(Number(f.createdAt)) : Date.now()
    });
  });
  tree.files = files.length > MAX_FILES ? files.slice(0, MAX_FILES) : files;

  const exp = Number(raw.exp);
  tree.exp = isFinite(exp) ? Math.max(0, Math.min(1500, Math.floor(exp))) : 0;

  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map(normalizeTask).filter(Boolean);
  tree.tasks = tasks.length > MAX_TASKS ? tasks.slice(0, MAX_TASKS) : tasks;
  tree.week = (raw.week && typeof raw.week === 'object' && typeof raw.week.key === 'string')
    ? { key: raw.week.key.slice(0, 20) }
    : { key: '' };
  tree.timer = sanitizeTimer(raw.timer);

  return tree;
}

async function readTree(uid) {
  try {
    return sanitizeTree(JSON.parse(await fsp.readFile(treePath(uid), 'utf8')));
  } catch (e) {
    return defaultTree();
  }
}

async function writeTree(uid, tree) {
  const clean = sanitizeTree(tree);
  await fsp.mkdir(notesDir(uid), { recursive: true });
  await writeJson(treePath(uid), clean);
  return clean;
}

function notePathFor(uid, storedAs) {
  const dir = notesDir(uid);
  const safe = safeFileName(storedAs);
  const full = path.join(dir, safe);
  if (path.dirname(full) !== dir) return null;
  return full;
}

/* ------------------------------------------------------------------ */
/* 蓝图                                                                */
/* ------------------------------------------------------------------ */

/* 蓝图市场固定四类，和study-tree的分类无关 */
const BP_CATEGORIES = [
  { id: 'sport', name: '运动' },
  { id: 'study', name: '学习' },
  { id: 'art', name: '艺术' },
  { id: 'other', name: '其他' }
];
const BP_CAT_IDS = BP_CATEGORIES.map((c) => c.id);
// 蓝图可见性：public 公开 / friends 仅好友可见 / private 私人
const BP_VISIBILITIES = [
  { id: 'public', name: '公开' },
  { id: 'friends', name: '仅好友' },
  { id: 'private', name: '私人' }
];
const BP_VIS_IDS = BP_VISIBILITIES.map((v) => v.id);
// 试运行阶段默认 0（不拦截）。将来要「高于一定分数才能上架」时设成比如 60。
const BP_MIN_SCORE = Number(process.env.BP_MIN_SCORE || 0) || 0;

function bpCatName(id) {
  const c = BP_CATEGORIES.find((x) => x.id === id);
  return c ? c.name : '其他';
}

/* 老蓝图没有 category 字段：按名字猜，猜不到归「其他」 */
function bpCategoryOf(b) {
  if (b && BP_CAT_IDS.indexOf(b.category) > -1) return b.category;
  const byName = BP_CATEGORIES.find((c) => c.name === (b && b.categoryName));
  if (byName) return byName.id;
  const title = String((b && (b.title + ' ' + b.note)) || '');
  if (/运动|健身|跑步|游泳|篮球|瑜伽/.test(title)) return 'sport';
  if (/艺术|绘画|素描|音乐|设计|摄影/.test(title)) return 'art';
  if (/学习|数学|编程|语言|阅读|算法/.test(title)) return 'study';
  return 'other';
}

function bpVisibilityName(id) {
  const v = BP_VISIBILITIES.find((x) => x.id === id);
  return v ? v.name : '公开';
}

/* 当前用户能否看到某份蓝图：自己总是能看；公开所有人；仅好友需是好友；私人只有自己 */
function canSeeBp(uid, b) {
  if (!b || b.ownerId === uid) return true;
  // 主人关掉了「蓝图对好友可见」：除公开蓝图外都不再展示
  const owner = users.find((u) => u.id === b.ownerId);
  if (owner && normalizePrivacy(owner.privacy).bp === false) {
    return (b.visibility || 'public') === 'public';
  }
  const vis = b.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'friends') return areFriends(uid, b.ownerId);
  return false;
}

/* 试运行评分：标题 + 说明 + 节点 + 节点笔记 + 附件 五个维度，总分 100 */
function scoreBlueprint(bp) {
  const title = String(bp.title || '').trim();
  const note = String(bp.note || '').trim();
  const nodes = Array.isArray(bp.nodes) ? bp.nodes : [];
  const files = Array.isArray(bp.files) ? bp.files : [];

  const parts = {
    title: title.length >= 8 ? 10 : title.length >= 4 ? 8 : title.length >= 2 ? 4 : 0,
    note: note.length >= 60 ? 30 : note.length >= 30 ? 25 : note.length >= 10 ? 18 : note.length >= 1 ? 8 : 0,
    nodes: nodes.length >= 4 ? 15 : nodes.length >= 2 ? 10 : nodes.length >= 1 ? 5 : 0,
    nodeNotes: 0,
    files: Math.min(15, files.length * 3),
    size: files.length && (bp.size || 0) > 0 ? 5 : 0
  };
  const withNote = nodes.filter((x) => String(x.note || '').trim().length >= 10).length;
  const totalNoteLen = nodes.reduce((sum, x) => sum + String(x.note || '').trim().length, 0);
  parts.nodeNotes = Math.min(18, withNote * 6) + Math.min(12, Math.floor(totalNoteLen / 150));
  const score = Math.min(100, Math.round(Object.values(parts).reduce((sum, v) => sum + v, 0)));
  return { score: score, parts: parts };
}

function withBpScore(b) {
  const r = scoreBlueprint(b);
  return Object.assign({}, b, { score: r.score, scoreParts: r.parts });
}

function withBpCategory(b) {
  const category = bpCategoryOf(b);
  return Object.assign({}, b, { category: category, categoryName: bpCatName(category) });
}

async function loadBlueprints() {
  const list = await readJson(BP_FILE, []);
  return Array.isArray(list) ? list.map(withBpCategory) : [];
}

async function saveBlueprints(list) {
  await writeJson(BP_FILE, list);
}

function collectSubtree(tree, rootId) {
  const root = tree.abilities.find((a) => a.id === rootId);
  if (!root) return null;
  const ids = new Set([rootId]);
  let guard = 0, added = 0;
  do {
    added = 0;
    tree.abilities.forEach((a) => {
      if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); added++; }
    });
  } while (added && guard++ < 200);

  const nodes = tree.abilities.filter((a) => ids.has(a.id));
  const files = tree.files.filter((f) => ids.has(f.nodeId));
  return { root, nodes, files };
}

/* ------------------------------------------------------------------ */
/* 路由：鉴权                                                          */
/* ------------------------------------------------------------------ */

async function handleAuth(req, res, url) {
  const p = url.pathname;

  /* 轻量验证码：一次性算术题（无需第三方服务），5 分钟有效、答过即作废 */
  if (p === '/api/auth/challenge' && req.method === 'GET') {
    if (hitsKey('chal:' + clientIp(req), 60, 10 * 60 * 1000)) {
      return fail(res, 429, '请求太频繁，请稍后再试');
    }
    const a = crypto.randomInt(2, 10);
    const b = crypto.randomInt(2, 10);
    const id = crypto.randomBytes(8).toString('hex');
    regChallenges.set(id, { sum: a + b, exp: Date.now() + 5 * 60 * 1000 });
    if (regChallenges.size > 2000) {
      const now = Date.now();
      Array.from(regChallenges.keys()).forEach((k) => {
        const v = regChallenges.get(k);
        if (!v || v.exp < now) regChallenges.delete(k);
      });
    }
    return sendJson(res, 200, { id: id, q: a + ' + ' + b + ' = ?' });
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const u = currentUser(req);
    return sendJson(res, 200, { user: publicUser(u) });
  }

  if (p === '/api/auth/register' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    const ip = clientIp(req);
    const rateKey = 'reg:' + ip;
    const dayKey = 'reg-day:' + ip;
    const blocked = hitsBlocked(rateKey) || hitsBlocked(dayKey);
    if (blocked) return fail(res, 429, '注册太频繁，请 ' + blocked + ' 分钟后再试');
    // 双重限速：同一 IP 每小时 5 次、每天 15 次
    if (hitsKey(dayKey, 15, 24 * 60 * 60 * 1000)) {
      return fail(res, 429, '这个地址今天注册次数已达上限，请明天再试');
    }
    if (hitsKey(rateKey, 5, 60 * 60 * 1000)) {
      return fail(res, 429, '注册太频繁，请 1 小时后再试');
    }

    // 验证码：一次性算术题，缺失或不答对直接拒绝（挡批量注册）
    if (!consumeChallenge(body.challengeId, body.answer)) {
      return fail(res, 400, '验证码不正确，请刷新后重新填写');
    }

    // TT_CLOSE_REGISTER=1：已有账号后关闭注册，只有管理员能建号（公网站点建议开）
    if (process.env.TT_CLOSE_REGISTER === '1' && users.length > 0) {
      return fail(res, 403, '本站已关闭自助注册，请联系管理员开通账号');
    }

    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (name.length < 2 || name.length > 20) return fail(res, 400, '用户名 2–20 个字符');
    if (password.length < 8) return fail(res, 400, '密码至少 8 位');
    if (findUserByName(name)) return fail(res, 409, '这个用户名不可用，换一个试试');

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: newId('u'),
      name: name,
      salt: salt,
      hash: await hashPassword(password, salt),
      createdAt: Date.now(),
      role: users.some((u) => u.role === 'admin') ? 'user' : 'admin',
      lastLoginAt: Date.now()
    };
    users.push(user);
    await writeJson(USERS_FILE, users);
    await fsp.mkdir(notesDir(user.id), { recursive: true });

    // 第一个账号：把旧的单用户数据搬过来
    let migrated = 0;
    if (users.length === 1 && fs.existsSync(LEGACY_TREE)) {
      try {
        const legacy = sanitizeTree(JSON.parse(await fsp.readFile(LEGACY_TREE, 'utf8')));
        if (legacy.abilities.length) {
          legacy.abilities.forEach((a) => {
            if (!a.parentId) a.categoryId = a.categoryId || DEFAULT_CATEGORIES[2].id;
          });
          await fsp.mkdir(notesDir(user.id), { recursive: true });
          if (fs.existsSync(LEGACY_NOTES)) {
            const names = await fsp.readdir(LEGACY_NOTES);
            for (const n of names) {
              await fsp.copyFile(path.join(LEGACY_NOTES, n), path.join(notesDir(user.id), n)).catch(() => {});
            }
          }
          await writeTree(user.id, legacy);
          migrated = legacy.abilities.length;
          await fsp.rename(LEGACY_TREE, LEGACY_TREE + '.migrated').catch(() => {});
        }
      } catch (e) { /* 迁移失败不影响注册 */ }
    }

    issueSession(req, res, user);
    return sendJson(res, 200, { user: publicUser(user), migrated: migrated });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    const ip = clientIp(req);
    const nameKey = String(body.name || '').trim().toLowerCase();
    const ipKey = 'login-ip:' + ip;
    const userKey = 'login-user:' + ip + ':' + nameKey;

    const waitIp = hitsBlocked(ipKey);
    if (waitIp) return fail(res, 429, '尝试次数过多，请 ' + waitIp + ' 分钟后再试');
    const waitUser = hitsBlocked(userKey);
    if (waitUser) return fail(res, 429, '这个账号尝试次数过多，请 ' + waitUser + ' 分钟后再试');

    const user = findUserByName(body.name);
    if (!user) {
      hitsKey(ipKey, 20, 10 * 60 * 1000);
      hitsKey(userKey, 5, 10 * 60 * 1000);
      return fail(res, 401, '用户名或密码不对');
    }
    const hash = await hashPassword(String(body.password || ''), user.salt);
    if (hash.length !== user.hash.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash))) {
      const badIp = hitsKey(ipKey, 20, 10 * 60 * 1000);
      const badUser = hitsKey(userKey, 5, 10 * 60 * 1000);
      if (badIp || badUser) return fail(res, 429, '密码错误次数过多，账号已临时锁定 10 分钟');
      return fail(res, 401, '用户名或密码不对');
    }
    // 登录成功：清掉这个账号的失败计数
    clearHits('login-user:' + ip + ':' + nameKey);
    user.lastLoginAt = Date.now();
    writeJson(USERS_FILE, users).catch(() => {});
    issueSession(req, res, user);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req).sid;
    if (token && sessions[token]) {
      delete sessions[token];
      writeJson(SESSIONS_FILE, sessions).catch(() => {});
    }
    res.setHeader('Set-Cookie',
      'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (PUBLIC_MODE ? '; Secure' : ''));
    return sendJson(res, 200, { ok: true });
  }

  /* 修改密码：校验旧密码，改完后注销该用户的其他会话，只保留当前这台设备 */
  if (p === '/api/auth/password' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    const oldPass = String(body.oldPassword || '');
    const newPass = String(body.newPassword || '');
    if (!oldPass || !newPass) return fail(res, 400, '旧密码和新密码都要填');
    if (newPass.length < 8) return fail(res, 400, '新密码至少 8 位');
    if (newPass === oldPass) return fail(res, 400, '新密码不能和旧密码一样');

    const me = currentUser(req);
    if (!me) return fail(res, 401, '请先登录');

    const oldHash = await hashPassword(oldPass, me.salt);
    if (oldHash.length !== me.hash.length || !crypto.timingSafeEqual(Buffer.from(oldHash), Buffer.from(me.hash))) {
      return fail(res, 401, '旧密码不对');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    me.salt = salt;
    me.hash = await hashPassword(newPass, salt);
    me.passwordChangedAt = Date.now();
    await writeJson(USERS_FILE, users);

    const curToken = parseCookies(req).sid;
    let killed = 0;
    Object.keys(sessions).forEach((t) => {
      if (sessions[t] && sessions[t].uid === me.id && t !== curToken) {
        delete sessions[t];
        killed++;
      }
    });
    if (killed) await writeJson(SESSIONS_FILE, sessions).catch(() => {});

    return sendJson(res, 200, { ok: true, killed: killed });
  }

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------------ */
/* 路由：业务                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url, user) {
  const p = url.pathname;
  const uid = user.id;

  if (p === '/api/users/me' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    if (body.displayName !== undefined) {
      const dn = String(body.displayName || '').trim().slice(0, 20);
      user.displayName = dn;
    }
    if (body.avatar !== undefined) {
      const av = String(body.avatar || '');
      if (av && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(av)) {
        return fail(res, 400, '头像格式不正确');
      }
      if (av.length > 400000) return fail(res, 400, '头像太大了，请用 256×256 以内的图片');
      user.avatar = av || '';
    }
    if (body.privacy !== undefined) user.privacy = normalizePrivacy(body.privacy);
    await writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (p === '/api/tree' && req.method === 'GET') {
    return sendJson(res, 200, await readTree(uid));
  }

  if (p === '/api/tree' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求内容不是合法的 JSON'); }
    const clean = await writeTree(uid, body);
    return sendJson(res, 200, { ok: true, tree: clean });
  }

  if (p === '/api/prune' && req.method === 'POST') {
    const tree = await readTree(uid);
    const keep = new Set(tree.files.map((f) => safeFileName(f.storedAs)).filter(Boolean));
    let removed = 0;
    try {
      const names = await fsp.readdir(notesDir(uid));
      for (const n of names) {
        if (keep.has(n)) continue;
        await fsp.unlink(path.join(notesDir(uid), n)).catch(() => {});
        removed++;
      }
    } catch (e) { /* 目录还不存在 */ }
    return sendJson(res, 200, { ok: true, removed: removed });
  }

  if (p === '/api/notes' && req.method === 'POST') {
    const name = safeFileName(url.searchParams.get('name') || '');
    const nodeId = (url.searchParams.get('nodeId') || '').slice(0, 64);
    if (!nodeId) return fail(res, 400, '缺少 nodeId');
    if (!/\.(md|markdown|pdf|txt|doc|docx|ppt|pptx|png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      return fail(res, 400, '不支持这个文件类型');
    }

    const buf = await readBody(req);
    if (!buf.length) return fail(res, 400, '文件是空的');

    const id = newId('f');
    const storedAs = `${id}-${name}`;
    await fsp.mkdir(notesDir(uid), { recursive: true });
    await fsp.writeFile(path.join(notesDir(uid), storedAs), buf);

    return sendJson(res, 201, {
      ok: true,
      file: {
        id: id, nodeId: nodeId, name: name,
        mime: extMime(name),
        size: buf.length, storedAs: storedAs, createdAt: Date.now()
      }
    });
  }

  const noteMatch = p.match(/^\/api\/notes\/(.+)$/);
  if (noteMatch) {
    const storedAs = decodeURIComponent(noteMatch[1]);
    const full = notePathFor(uid, storedAs);
    if (!full) return fail(res, 400, '非法文件名');

    if (req.method === 'GET') {
      let stat;
      try { stat = await fsp.stat(full); } catch (e) { return fail(res, 404, '文件不存在'); }
      res.writeHead(200, {
        'Content-Type': extMime(storedAs),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(storedAs.replace(/^[^-]+-/, ''))}`
      });
      fs.createReadStream(full).pipe(res);
      return;
    }
    if (req.method === 'PUT') {
      const buf = await readBody(req);
      try { await fsp.writeFile(full, buf); } catch (e) { return fail(res, 404, '文件不存在，请重新上传'); }
      return sendJson(res, 200, { ok: true, size: buf.length });
    }
    if (req.method === 'DELETE') {
      await fsp.unlink(full).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
  }

  /* 节点描述照片：上传 / 读取 / 删除 */
  if (p === '/api/photos' && req.method === 'POST') {
    const name = safeFileName(url.searchParams.get('name') || '');
    const nodeId = (url.searchParams.get('nodeId') || '').slice(0, 64);
    if (!nodeId) return fail(res, 400, '缺少 nodeId');
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return fail(res, 400, '只支持图片文件');
    const buf = await readBody(req);
    if (!buf.length) return fail(res, 400, '文件是空的');
    const id = newId('ph');
    const storedAs = `${id}-${name}`;
    await fsp.mkdir(photosDir(uid), { recursive: true });
    await fsp.writeFile(path.join(photosDir(uid), storedAs), buf);
    return sendJson(res, 201, {
      ok: true,
      photo: {
        id: id, nodeId: nodeId, name: name, mime: extMime(name),
        size: buf.length, storedAs: storedAs, createdAt: Date.now()
      }
    });
  }

  const photoMatch = p.match(/^\/api\/photos\/(.+)$/);
  if (photoMatch) {
    const storedAs = decodeURIComponent(photoMatch[1]);
    const full = photoPathFor(uid, storedAs);
    if (!full) return fail(res, 400, '非法文件名');
    if (req.method === 'GET') {
      let stat;
      try { stat = await fsp.stat(full); } catch (e) { return fail(res, 404, '图片不存在'); }
      res.writeHead(200, {
        'Content-Type': extMime(storedAs),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(full).pipe(res);
      return;
    }
    if (req.method === 'DELETE') {
      await fsp.unlink(full).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/export' && req.method === 'GET') {
    const tree = await readTree(uid);
    const files = [];
    for (const f of tree.files) {
      const entry = { id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime, size: f.size, createdAt: f.createdAt };
      const full = notePathFor(uid, f.storedAs);
      try { if (full) entry.data = (await fsp.readFile(full)).toString('base64'); } catch (e) {}
      files.push(entry);
    }
    return sendJson(res, 200, {
      format: 'tech-tree', version: VERSION,
      exportedAt: new Date().toISOString(),
      owner: user.name,
      points: tree.points,
      categories: tree.categories,
      abilities: tree.abilities,
      files: files,
      tasks: tree.tasks,
      week: tree.week,
      timer: tree.timer
    });
  }

  if (p === '/api/import' && req.method === 'POST') {
    let doc;
    try { doc = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '文件不是合法的 JSON'); }
    if (!Array.isArray(doc.abilities)) return fail(res, 400, '这个文件里没有study-tree数据（缺少 abilities）');

    const backupDir = path.join(userDir(uid), 'backup', stamp());
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.copyFile(treePath(uid), path.join(backupDir, 'tree.json')).catch(() => {});
    try {
      const names = await fsp.readdir(notesDir(uid));
      if (names.length) {
        await fsp.rename(notesDir(uid), path.join(backupDir, 'notes')).catch(() => {});
      }
    } catch (e) {}
    await fsp.mkdir(notesDir(uid), { recursive: true });

    const tree = sanitizeTree(Object.assign({}, doc, { files: [] }));
    const valid = new Set(tree.abilities.map((a) => a.id));
    const kept = [];
    for (const f of Array.isArray(doc.files) ? doc.files : []) {
      if (!f || !valid.has(f.nodeId)) continue;
      const name = safeFileName(f.name || '');
      if (!name) continue;
      const id = typeof f.id === 'string' && f.id ? f.id.slice(0, 64) : newId('f');
      let storedAs = '';
      if (typeof f.data === 'string' && f.data) {
        storedAs = `${id}-${name}`;
        await fsp.writeFile(path.join(notesDir(uid), storedAs), Buffer.from(f.data, 'base64')).catch(() => { storedAs = ''; });
      }
      kept.push({
        id: id, nodeId: f.nodeId, name: name,
        mime: typeof f.mime === 'string' ? f.mime : extMime(name),
        size: isFinite(Number(f.size)) ? Number(f.size) : 0,
        storedAs: storedAs,
        createdAt: isFinite(Number(f.createdAt)) ? Number(f.createdAt) : Date.now()
      });
    }
    tree.files = kept;
    const saved = await writeTree(uid, tree);
    return sendJson(res, 200, { ok: true, tree: saved });
  }

  /* ---------------- 蓝图 ---------------- */

  if (p === '/api/blueprints' && req.method === 'GET') {
    const scope = String(url.searchParams.get('scope') || 'all');
    const cat = String(url.searchParams.get('cat') || '');
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const friendOnly = url.searchParams.get('friend') === '1';

    const all = await loadBlueprints();
    let list = all.filter((b) => {
      const mine = b.ownerId === uid;
      if (scope === 'mine') return mine;
      if (scope === 'others') return !mine && canSeeBp(uid, b);
      return canSeeBp(uid, b);
    });

    // 「好友蓝图」：只看好友发布的（不含自己），且仅保留好友可见的那部分
    if (friendOnly) list = list.filter((b) => b.ownerId !== uid && areFriends(uid, b.ownerId));

    // 指定作者：看别人图谱时只看这个人的蓝图
    const ownerFilter = String(url.searchParams.get('owner') || '');
    if (ownerFilter) list = list.filter((b) => b.ownerId === ownerFilter);

    if (q) {
      list = list.filter((b) =>
        String(b.title || '').toLowerCase().indexOf(q) > -1 ||
        String(b.note || '').toLowerCase().indexOf(q) > -1 ||
        String(b.ownerName || '').toLowerCase().indexOf(q) > -1
      );
    }

    const counts = { all: list.length, friends: 0 };
    BP_CAT_IDS.forEach((id) => { counts[id] = 0; });
    list.forEach((b) => {
      counts[b.category] = (counts[b.category] || 0) + 1;
      if (b.ownerId !== uid && areFriends(uid, b.ownerId)) counts.friends++;
    });

    if (cat && BP_CAT_IDS.indexOf(cat) > -1) list = list.filter((b) => b.category === cat);

    const brief = list
      .slice()
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map((b) => {
        const sc = scoreBlueprint(b);
        return {
          id: b.id, title: b.title, note: b.note, ownerName: b.ownerName,
          ownerId: b.ownerId,
          category: b.category, categoryName: b.categoryName,
          visibility: b.visibility || 'public',
          visibilityName: bpVisibilityName(b.visibility || 'public'),
          nodeCount: b.nodes.length,
          fileCount: b.files.length, size: b.size,
          createdAt: b.createdAt, updatedAt: b.updatedAt || b.createdAt,
          sourceNodeId: b.sourceNodeId || '',
          cover: (b.images && b.images.length) ? ('/api/blueprints/' + b.id + '/images/' + b.images[0].id) : '',
          imageCount: (b.images || []).length,
          score: sc.score,
          belowThreshold: BP_MIN_SCORE > 0 && sc.score < BP_MIN_SCORE,
          mine: b.ownerId === uid
        };
      });
    return sendJson(res, 200, { blueprints: brief, counts: counts, total: brief.length });
  }

  if (p === '/api/blueprints' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    const nodeId = String(body.nodeId || '');
    const tree = await readTree(uid);
    const sub = collectSubtree(tree, nodeId);
    if (!sub) return fail(res, 404, '找不到这个父级');
    if (sub.root.kind !== 'group') return fail(res, 400, '只能把父级能力发布成蓝图');

    const id = newId('bp');
    const dir = path.join(BP_DIR, id);
    const filesDir = path.join(dir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });

    const files = [];
    for (const f of sub.files) {
      if (f.local) continue; // 本地笔记不打包进蓝图：服务器没有文件内容，蓝图只带描述和图
      const src = notePathFor(uid, f.storedAs);
      let storedAs = '';
      if (src && fs.existsSync(src)) {
        storedAs = safeFileName(f.storedAs);
        await fsp.copyFile(src, path.join(filesDir, storedAs)).catch(() => { storedAs = ''; });
      }
      files.push({
        id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime,
        size: f.size, storedAs: storedAs, createdAt: f.createdAt
      });
    }

    // 蓝图配图：最多 3 张，每张 ≤ 2MB（base64 dataURL）
    const images = [];
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
    if (rawImages.length) {
      const imgDir = path.join(dir, 'images');
      await fsp.mkdir(imgDir, { recursive: true });
      for (const img of rawImages) {
        if (!img || typeof img !== 'object') continue;
        const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(img.data || ''));
        if (!m) continue;
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length || buf.length > 2 * 1024 * 1024) continue;
        const imgId = newId('img');
        const storedAs = `${imgId}-${safeFileName(img.name || 'image.png')}`;
        await fsp.writeFile(path.join(imgDir, storedAs), buf);
        images.push({
          id: imgId,
          name: String(img.name || 'image').slice(0, 80),
          mime: m[1],
          size: buf.length,
          storedAs: storedAs
        });
      }
    }

    const treeCat = tree.categories.find((c) => c.id === sub.root.categoryId);
    let bpCategory = BP_CAT_IDS.indexOf(String(body.category || '')) > -1
      ? String(body.category)
      : bpCategoryOf({ categoryName: treeCat ? treeCat.name : '', title: sub.root.name });

    const bpBase = {
      id: id,
      title: String(body.title || sub.root.name).trim().slice(0, 40) || sub.root.name,
      note: String(body.note || '').trim().slice(0, 300),
      ownerId: uid,
      ownerName: displayNameOf(user),
      category: bpCategory,
      categoryName: bpCatName(bpCategory),
      visibility: BP_VIS_IDS.indexOf(String(body.visibility || '')) > -1 ? String(body.visibility) : 'public',
      treeCategoryName: treeCat ? treeCat.name : '',
      sourceNodeId: sub.root.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      size: files.reduce((s, f) => s + (f.size || 0), 0),
      nodes: sub.nodes.map((n) => ({
        id: n.id, name: n.name, cost: n.cost, unlocked: n.unlocked, kind: n.kind,
        parentId: n.parentId, prereqIds: n.prereqIds || [], note: n.note
      })),
      files: files,
      images: images
    };
    const bp = Object.assign(bpBase, scoreBlueprint(bpBase));
    await writeJson(path.join(dir, 'blueprint.json'), bp);

    const list = await loadBlueprints();
    list.push({
      id: bp.id, title: bp.title, note: bp.note, ownerId: bp.ownerId, ownerName: bp.ownerName,
      category: bp.category, categoryName: bp.categoryName, visibility: bp.visibility,
      sourceNodeId: bp.sourceNodeId, treeCategoryName: bp.treeCategoryName,
      createdAt: bp.createdAt, updatedAt: bp.updatedAt, size: bp.size,
      nodes: bp.nodes, files: bp.files, images: bp.images || []
    });
    await saveBlueprints(list);
    return sendJson(res, 201, { ok: true, blueprint: bp });
  }

  /* 蓝图配图 */
  const bpImgMatch = p.match(/^\/api\/blueprints\/([^/]+)\/images\/([^/]+)$/);
  if (bpImgMatch && req.method === 'GET') {
    const bpId0 = safeFileName(bpImgMatch[1]);
    const imgId = safeFileName(bpImgMatch[2]);
    const bp0 = await readJson(path.join(BP_DIR, bpId0, 'blueprint.json'), null);
    if (!bp0) return fail(res, 404, '蓝图不存在');
    if (!canSeeBp(uid, bp0)) return fail(res, 403, '无权查看这个蓝图');
    const img = (bp0.images || []).find((x) => x.id === imgId);
    if (!img) return fail(res, 404, '图片不存在');
    const full = path.join(BP_DIR, bpId0, 'images', safeFileName(img.storedAs || ''));
    let st;
    try { st = await fsp.stat(full); } catch (e) { return fail(res, 404, '图片文件不存在'); }
    res.writeHead(200, {
      'Content-Type': img.mime || 'image/png',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  const bpMatch = p.match(/^\/api\/blueprints\/([^/]+)(?:\/(import|refresh))?$/);
  if (bpMatch) {
    const bpId = safeFileName(bpMatch[1]);
    const action = bpMatch[2] || '';
    const isImport = action === 'import';
    const bp = await readJson(path.join(BP_DIR, bpId, 'blueprint.json'), null);
    if (!bp) return fail(res, 404, '蓝图不存在');
    if (!bp.category) {
      bp.category = bpCategoryOf(bp);
      bp.categoryName = bpCatName(bp.category);
    }

    /* 详情：给「我的蓝图库」看里面有哪些节点 */
    if (req.method === 'GET' && !action) {
      if (!canSeeBp(uid, bp)) return fail(res, 403, '这个蓝图只对作者/好友可见');
      return sendJson(res, 200, {
        blueprint: {
          id: bp.id,
          title: bp.title,
          note: bp.note,
          ownerName: bp.ownerName,
          mine: bp.ownerId === uid,
          category: bp.category,
          categoryName: bp.categoryName,
          visibility: bp.visibility || 'public',
          visibilityName: bpVisibilityName(bp.visibility || 'public'),
          sourceNodeId: bp.sourceNodeId || '',
          score: scoreBlueprint(bp).score,
          scoreParts: scoreBlueprint(bp).parts,
          belowThreshold: BP_MIN_SCORE > 0 && scoreBlueprint(bp).score < BP_MIN_SCORE,
          createdAt: bp.createdAt,
          updatedAt: bp.updatedAt || bp.createdAt,
          size: bp.size,
          nodes: (bp.nodes || []).map((x) => ({
            id: x.id, name: x.name, kind: x.kind, cost: x.cost,
            parentId: x.parentId || null, prereqIds: x.prereqIds || []
          })),
          files: (bp.files || []).map((x) => ({ name: x.name, size: x.size })),
          images: (bp.images || []).map((x) => ({ id: x.id, name: x.name, size: x.size, mime: x.mime }))
        }
      });
    }

    /* 编辑元信息：标题 / 说明 / 分类 */
    if (req.method === 'PUT' && !action) {
      if (bp.ownerId !== uid) return fail(res, 403, '只能编辑自己发布的蓝图');
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch (e) { return fail(res, 400, '请求格式有误'); }

      if (body.title !== undefined) {
        const t = String(body.title || '').trim().slice(0, 40);
        if (!t) return fail(res, 400, '标题不能为空');
        bp.title = t;
      }
      if (body.note !== undefined) bp.note = String(body.note || '').trim().slice(0, 300);
      if (body.category !== undefined) {
        if (BP_CAT_IDS.indexOf(String(body.category)) < 0) return fail(res, 400, '分类不合法');
        bp.category = String(body.category);
        bp.categoryName = bpCatName(bp.category);
      }
      if (body.visibility !== undefined) {
        if (BP_VIS_IDS.indexOf(String(body.visibility)) < 0) return fail(res, 400, '可见性不合法');
        bp.visibility = String(body.visibility);
      }
      /* 配图：带上 id 的表示保留原图，带 data 的表示新增（最多 3 张） */
      if (body.images !== undefined) {
        const imgDir = path.join(BP_DIR, bpId, 'images');
        const oldImages = bp.images || [];
        const next = [];
        const raw = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
        let ensuredDir = false;
        for (const img of raw) {
          if (!img || typeof img !== 'object') continue;
          if (img.id) {
            const hit = oldImages.find((x) => x.id === img.id);
            if (hit) { next.push(hit); continue; }
          }
          const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(img.data || ''));
          if (!m) continue;
          const buf = Buffer.from(m[2], 'base64');
          if (!buf.length || buf.length > 2 * 1024 * 1024) continue;
          if (!ensuredDir) { await fsp.mkdir(imgDir, { recursive: true }); ensuredDir = true; }
          const imgId = newId('img');
          const storedAs = `${imgId}-${safeFileName(img.name || 'image.png')}`;
          await fsp.writeFile(path.join(imgDir, storedAs), buf);
          next.push({
            id: imgId,
            name: String(img.name || 'image').slice(0, 80),
            mime: m[1],
            size: buf.length,
            storedAs: storedAs
          });
        }
        const keep = new Set(next.map((x) => x.id));
        for (const o of oldImages) {
          if (!keep.has(o.id)) {
            await fsp.rm(path.join(imgDir, safeFileName(o.storedAs || '')), { force: true }).catch(() => {});
          }
        }
        bp.images = next;
      }
      bp.updatedAt = Date.now();
      await writeJson(path.join(BP_DIR, bpId, 'blueprint.json'), bp);

      const list = await loadBlueprints();
      const idx = list.findIndex((b) => b.id === bpId);
      if (idx > -1) {
        list[idx] = Object.assign({}, list[idx], {
          title: bp.title, note: bp.note, category: bp.category,
          categoryName: bp.categoryName, visibility: bp.visibility, updatedAt: bp.updatedAt
        });
        await saveBlueprints(list);
      }
      return sendJson(res, 200, {
        ok: true,
        blueprint: {
          id: bp.id, title: bp.title, note: bp.note,
          category: bp.category, categoryName: bp.categoryName,
          visibility: bp.visibility, updatedAt: bp.updatedAt
        }
      });
    }

    /* 用当前study-tree重新同步内容（来源父级还在才行） */
    if (action === 'refresh' && req.method === 'POST') {
      if (bp.ownerId !== uid) return fail(res, 403, '只能更新自己发布的蓝图');
      if (!bp.sourceNodeId) {
        return fail(res, 400, '这个蓝图发布得比较早，没有记录来源节点，不能自动同步。可以只改标题/说明，或重新发布一份。');
      }
      const tree = await readTree(uid);
      const sub = collectSubtree(tree, bp.sourceNodeId);
      if (!sub) return fail(res, 404, '原来的父级已经被删除或改名，无法同步内容。');

      const filesDir = path.join(BP_DIR, bpId, 'files');
      await fsp.rm(filesDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(filesDir, { recursive: true });

      const files = [];
      for (const f of sub.files) {
        const src = notePathFor(uid, f.storedAs);
        let storedAs = '';
        if (src && fs.existsSync(src)) {
          storedAs = safeFileName(f.storedAs);
          await fsp.copyFile(src, path.join(filesDir, storedAs)).catch(() => { storedAs = ''; });
        }
        files.push({
          id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime,
          size: f.size, storedAs: storedAs, createdAt: f.createdAt
        });
      }

      bp.nodes = sub.nodes.map((x) => ({
        id: x.id, name: x.name, cost: x.cost, unlocked: x.unlocked, kind: x.kind,
        parentId: x.parentId, prereqIds: x.prereqIds || [], note: x.note
      }));
      bp.files = files;
      bp.size = files.reduce((sum, f) => sum + (f.size || 0), 0);
      bp.updatedAt = Date.now();
      Object.assign(bp, scoreBlueprint(bp));
      await writeJson(path.join(BP_DIR, bpId, 'blueprint.json'), bp);

      const list = await loadBlueprints();
      const idx = list.findIndex((b) => b.id === bpId);
      if (idx > -1) {
        list[idx] = Object.assign({}, list[idx], {
          nodes: bp.nodes, files: bp.files, size: bp.size, updatedAt: bp.updatedAt
        });
        await saveBlueprints(list);
      }
      return sendJson(res, 200, {
        ok: true,
        nodeCount: bp.nodes.length,
        fileCount: bp.files.length,
        size: bp.size,
        updatedAt: bp.updatedAt
      });
    }

    if (isImport && req.method === 'POST') {
      if (!canSeeBp(uid, bp)) return fail(res, 403, '这个蓝图只对作者/好友可见');
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) {}

      const tree = await readTree(uid);
      const targetCat = String(body.categoryId || '');
      const cat = tree.categories.find((c) => c.id === targetCat)
        || tree.categories.find((c) => c.name === bp.categoryName)
        || tree.categories[0];

      const idMap = {};
      bp.nodes.forEach((n) => { idMap[n.id] = newId('a'); });
      const nodes = bp.nodes.map((n) => ({
        id: idMap[n.id],
        name: n.name,
        cost: n.cost,
        unlocked: false,
        kind: n.kind,
        parentId: n.parentId ? (idMap[n.parentId] || null) : null,
        prereqIds: (n.prereqIds || []).map((id) => idMap[id]).filter(Boolean),
        categoryId: n.parentId ? null : cat.id,
        ox: 0, oy: 0,
        note: n.note || ''
      }));

      await fsp.mkdir(notesDir(uid), { recursive: true });
      const files = [];
      for (const f of bp.files) {
        const newNodeId = idMap[f.nodeId];
        if (!newNodeId) continue;
        const from = path.join(BP_DIR, bpId, 'files', safeFileName(f.storedAs || ''));
        const newStored = `${newId('f')}-${safeFileName(f.name)}`;
        if (f.storedAs && fs.existsSync(from)) {
          await fsp.copyFile(from, path.join(notesDir(uid), newStored)).catch(() => {});
        }
        files.push({
          id: newId('f'), nodeId: newNodeId, name: f.name, mime: f.mime,
          size: f.size, storedAs: newStored, createdAt: Date.now()
        });
      }

      tree.abilities = tree.abilities.concat(nodes);
      tree.files = tree.files.concat(files);
      const saved = await writeTree(uid, tree);
      return sendJson(res, 200, { ok: true, tree: saved, added: nodes.length, categoryId: cat.id });
    }

    if (req.method === 'DELETE' && !isImport) {
      if (bp.ownerId !== uid) return fail(res, 403, '只能删除自己发布的蓝图');
      const list = (await loadBlueprints()).filter((b) => b.id !== bpId);
      await saveBlueprints(list);
      await fsp.rm(path.join(BP_DIR, bpId), { recursive: true, force: true }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/users' && req.method === 'GET') {
    // 防用户枚举：必须给 ≥2 个字符，限制频率与返回条数，且不返回全站账号总数
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (hitsKey('search:' + uid, 60, 10 * 60 * 1000)) {
      return fail(res, 429, '搜索太频繁，请稍后再试');
    }
    if (q.length < 2) {
      return sendJson(res, 200, { users: [], needMore: true, selfName: user.name });
    }
    const list = users
      .filter((u) => u.id !== uid)
      .filter((u) => u.name.toLowerCase().indexOf(q) > -1 ||
        String(u.displayName || '').toLowerCase().indexOf(q) > -1)
      .slice(0, 12)
      .map((u) => ({ id: u.id, name: u.name, displayName: displayNameOf(u), avatar: typeof u.avatar === 'string' ? u.avatar : '', rel: relationOf(uid, u.id), friend: areFriends(uid, u.id) }));
    return sendJson(res, 200, { users: list, selfName: user.name });
  }

  if (p === '/api/friends' && req.method === 'GET') {
    const list = [];
    const incoming = [];
    const outgoing = [];
    friends
      .filter((f) => f.a === uid || f.b === uid)
      .forEach((f) => {
        const otherId = f.a === uid ? f.b : f.a;
        const other = users.find((u) => u.id === otherId);
        if (!other) return;
        const item = { id: other.id, name: displayNameOf(other), avatar: typeof other.avatar === 'string' ? other.avatar : '', at: f.at };
        if (f.status === 'pending') {
          (f.a === uid ? outgoing : incoming).push(item);
        } else {
          list.push(item);
        }
      });
    return sendJson(res, 200, { friends: list, incoming, outgoing });
  }

  if (p === '/api/friends' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }

    const target = users.find((u) => u.id === String(body.id || '')) || findUserByName(body.name);
    if (!target) return fail(res, 404, '没有这个用户');
    if (target.id === uid) return fail(res, 400, '不能加自己为好友');

    const rel = relationOf(uid, target.id);
    if (rel === 'friend') return sendJson(res, 200, { ok: true, already: true, rel: 'friend' });
    if (rel === 'out') return sendJson(res, 200, { ok: true, already: true, rel: 'out' });

    // 对方已经申请过我 → 直接算同意，省一次点击
    if (rel === 'in') {
      const f = linkBetween(uid, target.id);
      f.status = 'accepted';
      f.at = Date.now();
      await writeJson(FRIENDS_FILE, friends);
      return sendJson(res, 200, { ok: true, accepted: true, rel: 'friend', friend: { id: target.id, name: target.name } });
    }

    friends.push({ a: uid, b: target.id, at: Date.now(), status: 'pending' });
    await writeJson(FRIENDS_FILE, friends);
    return sendJson(res, 200, { ok: true, pending: true, rel: 'out', friend: { id: target.id, name: target.name } });
  }

  const acceptMatch = p.match(/^\/api\/friends\/([^/]+)\/accept$/);
  if (acceptMatch && req.method === 'POST') {
    const fromId = acceptMatch[1];
    const f = friends.find((x) => x.a === fromId && x.b === uid && x.status === 'pending');
    if (!f) return fail(res, 404, '没有这条好友申请');
    const sender = users.find((u) => u.id === fromId);
    if (!sender) return fail(res, 404, '用户不存在');
    f.status = 'accepted';
    f.at = Date.now();
    await writeJson(FRIENDS_FILE, friends);
    return sendJson(res, 200, { ok: true, friend: { id: sender.id, name: sender.name } });
  }

  const rejectMatch = p.match(/^\/api\/friends\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const fromId = rejectMatch[1];
    const before = friends.length;
    friends = friends.filter((f) => !(f.a === fromId && f.b === uid && f.status === 'pending'));
    if (friends.length !== before) await writeJson(FRIENDS_FILE, friends);
    return sendJson(res, 200, { ok: true });
  }

  const friendMatch = p.match(/^\/api\/friends\/([^/]+)$/);
  if (friendMatch && req.method === 'DELETE') {
    const targetId = friendMatch[1];
    const before = friends.length;
    friends = friends.filter((f) => !((f.a === uid && f.b === targetId) || (f.b === uid && f.a === targetId)));
    if (friends.length !== before) await writeJson(FRIENDS_FILE, friends);
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- 好友私聊 ---------------- */
  const chatMatch = p.match(/^\/api\/chat\/([^/]+)$/);
  if (chatMatch) {
    const otherId = chatMatch[1];
    const other = users.find((u) => u.id === otherId);
    if (!other) return fail(res, 404, '没有这个用户');
    if (!areFriends(uid, otherId)) return fail(res, 403, '只能和好友聊天');

    if (req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0) || 0;
      const list = chats
        .filter((m) => (m.from === uid && m.to === otherId) || (m.from === otherId && m.to === uid))
        .filter((m) => m.at > after)
        .sort((a, b) => a.at - b.at)
        .slice(-200)
        .map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at }));
      return sendJson(res, 200, {
        messages: list,
        friend: { id: other.id, name: displayNameOf(other), avatar: typeof other.avatar === 'string' ? other.avatar : '' }
      });
    }

    if (req.method === 'POST') {
      if (hitsKey('chat:' + uid, 120, 10 * 60 * 1000)) {
        return fail(res, 429, '发得太快了，歇一会儿再发');
      }
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch (e) { return fail(res, 400, '请求格式有误'); }
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return fail(res, 400, '消息不能为空');

      const msg = { id: newId('m'), from: uid, to: otherId, text: text, at: Date.now() };
      chats.push(msg);
      if (chats.length > 5000) chats = chats.slice(-4000);
      await writeJson(CHAT_FILE, chats);
      return sendJson(res, 200, { message: { id: msg.id, from: msg.from, text: msg.text, at: msg.at } });
    }
  }

  const friendTree = p.match(/^\/api\/users\/([^/]+)\/tree$/);
  if (friendTree && req.method === 'GET') {
    const targetId = friendTree[1];
    if (targetId !== uid && !isAdmin(user) && !areFriends(uid, targetId)) {
      return fail(res, 403, '对方同意好友申请后才能看');
    }
    const target = users.find((u) => u.id === targetId);
    if (!target) return fail(res, 404, '用户不存在');
    const pv = normalizePrivacy(target.privacy);
    if (targetId !== uid && !isAdmin(user) && !pv.tree) {
      return fail(res, 403, '对方没有开放图谱给好友');
    }
    const t = await readTree(targetId);
    // 时间安排单独开关：对好友隐藏时不下发
    if (targetId !== uid && !pv.timer) {
      t.timer = { rate: 50, courses: [], plans: [], spent: 0, bonus: 0, weekKey: '', weeks: {} };
      t.timerHidden = true;
    }
    return sendJson(res, 200, { user: publicUser(target), tree: t });
  }

  /* ---------------- 管理员：账号一览 ---------------- */
  if (p === '/api/admin/users' && req.method === 'GET') {
    if (adminOnly(res, user)) return;
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const bpsAll = await loadBlueprints();
    const list = [];
    for (const u of users) {
      if (q && String(u.name || '').toLowerCase().indexOf(q) < 0 && String(u.id || '').toLowerCase().indexOf(q) < 0) continue;
      const t = await readTree(u.id);
      const leaves = t.abilities.filter((a) => a.kind !== 'group');
      list.push({
        id: u.id,
        name: u.name,
        displayName: displayNameOf(u),
        avatar: typeof u.avatar === 'string' && u.avatar ? u.avatar : '',
        role: u.role === 'admin' ? 'admin' : 'user',
        createdAt: u.createdAt || 0,
        lastLoginAt: u.lastLoginAt || 0,
        nodes: t.abilities.length,
        groups: t.abilities.length - leaves.length,
        leaves: leaves.length,
        unlocked: leaves.filter((a) => a.unlocked).length,
        points: t.points,
        exp: t.exp || 0,
        files: t.files.length,
        feedback: feedback.filter((f) => f.userId === u.id).length,
        blueprints: bpsAll.filter((b) => b.ownerId === u.id).length,
        isSelf: u.id === uid
      });
    }
    // 管理员排前面，同级按注册先后
    list.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    return sendJson(res, 200, { users: list, total: list.length });
  }

  const adminBpMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/blueprints$/);
  if (adminBpMatch && req.method === 'GET') {
    if (adminOnly(res, user)) return;
    const targetId = adminBpMatch[1];
    const target = users.find((u) => u.id === targetId);
    if (!target) return fail(res, 404, '用户不存在');
    const list = (await loadBlueprints())
      .filter((b) => b.ownerId === targetId)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map((b) => ({
        id: b.id, title: b.title, note: b.note,
        category: b.category, categoryName: b.categoryName,
        nodeCount: (b.nodes || []).length,
        fileCount: (b.files || []).length,
        size: b.size || 0,
        createdAt: b.createdAt, updatedAt: b.updatedAt || b.createdAt
      }));
    return sendJson(res, 200, { user: publicUser(target), blueprints: list, total: list.length });
  }

  const roleMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (roleMatch && req.method === 'POST') {
    if (adminOnly(res, user)) return;
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }
    const target = users.find((u) => u.id === roleMatch[1]);
    if (!target) return fail(res, 404, '用户不存在');
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (target.role === 'admin' && role !== 'admin') {
      const others = users.filter((u) => u.id !== target.id && u.role === 'admin');
      if (!others.length) return fail(res, 400, '至少需要保留一个管理员');
    }
    target.role = role;
    await writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }

  /* ---------------- 反馈 ---------------- */
  if (p === '/api/feedback' && req.method === 'GET') {
    const admin = isAdmin(user);
    const list = (admin ? feedback : feedback.filter((f) => f.userId === uid))
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
    return sendJson(res, 200, {
      feedback: list,
      admin: admin,
      openCount: list.filter((f) => f.status !== 'done').length
    });
  }

  if (p === '/api/feedback' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }
    const text = String(body.text || '').trim();
    const contact = String(body.contact || '').trim().slice(0, 120);
    if (text.length < 2) return fail(res, 400, '请把反馈内容写清楚一点');
    if (text.length > 2000) return fail(res, 400, '反馈内容最多 2000 字');
    const item = {
      id: newId('fb'),
      userId: uid,
      userName: displayNameOf(user),
      text: text.slice(0, 2000),
      contact: contact,
      status: 'open',
      reply: '',
      createdAt: Date.now(),
      repliedAt: 0
    };
    feedback.push(item);
    await writeJson(FEEDBACK_FILE, feedback);
    return sendJson(res, 200, { ok: true, item: item });
  }

  const fbAct = p.match(/^\/api\/feedback\/([^/]+)\/reply$/);
  if (fbAct && req.method === 'POST') {
    if (adminOnly(res, user)) return;
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { return fail(res, 400, '请求格式有误'); }
    const item = feedback.find((f) => f.id === fbAct[1]);
    if (!item) return fail(res, 404, '反馈不存在');
    if (body.reply !== undefined) item.reply = String(body.reply || '').trim().slice(0, 2000);
    item.status = body.status === 'open' ? 'open' : 'done';
    item.repliedAt = Date.now();
    item.repliedBy = user.name;
    await writeJson(FEEDBACK_FILE, feedback);
    return sendJson(res, 200, { ok: true, item: item });
  }

  const fbDel = p.match(/^\/api\/feedback\/([^/]+)$/);
  if (fbDel && req.method === 'DELETE') {
    if (adminOnly(res, user)) return;
    const before = feedback.length;
    feedback = feedback.filter((f) => f.id !== fbDel[1]);
    if (feedback.length !== before) await writeJson(FEEDBACK_FILE, feedback);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, version: VERSION, user: publicUser(user) });
  }

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return fail(res, 400, '非法路径'); }
  if (rel === '/' || rel === '') rel = '/index.html';

  // 白名单之外一律 404：/data/*、/.workbuddy/*、server.js、备份目录都不会被下载
  if (STATIC_FILES.has(rel) === false) return fail(res, 404, '页面不存在');
  if (rel.indexOf('..') > -1) return fail(res, 403, '禁止访问');

  const full = path.join(ROOT, rel.slice(1));
  if (!full.startsWith(ROOT)) return fail(res, 403, '禁止访问');

  let stat;
  try { stat = await fsp.stat(full); } catch (e) { return fail(res, 404, '页面不存在'); }
  if (!stat.isFile()) return fail(res, 404, '页面不存在');

  const ext = path.extname(full).toLowerCase();

  // HTML 走字符串返回：给内联 <script> 打上本次请求的 CSP nonce
  if (ext === '.html') {
    let html;
    try { html = await fsp.readFile(full, 'utf8'); } catch (e) { return fail(res, 404, '页面不存在'); }
    html = html.replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g,
      '<script nonce="' + res._cspNonce + '"');
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    return res.end(buf);
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(full).pipe(res);
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res._cspNonce = crypto.randomBytes(16).toString('base64');
  securityHeaders(req, res);
  try {
    if (url.pathname === '/api/hello' && req.method === 'GET') {
      return sendJson(res, 200, {
        app: 'study-tree',
        apiVersion: API_VERSION
      });
    }

    /* 使用说明：存在服务器里，前端点击后渲染 */
    if (url.pathname === '/api/doc' && req.method === 'GET') {
      let text = '';
      for (const name of ['使用说明.md', 'README.md']) {
        try {
          text = await fsp.readFile(path.join(ROOT, name), 'utf8');
          if (text) break;
        } catch (e) { /* 试下一个 */ }
      }
      return sendJson(res, 200, {
        ok: true,
        title: '使用说明',
        markdown: text || '# 使用说明\n\n文档还没准备好。'
      });
    }

    if (url.pathname.startsWith('/api/auth/')) return await handleAuth(req, res, url);

    if (url.pathname.startsWith('/api/')) {
      const user = currentUser(req);
      if (!user) return fail(res, 401, '请先登录');
      return await handleApi(req, res, url, user);
    }

    return await serveStatic(req, res, url);
  } catch (e) {
    if (e && e.message === 'body-too-large') return fail(res, 413, '文件太大（上限 64MB）');
    console.error('[study-tree] 请求处理失败：', e && e.message);
    if (!res.headersSent) return fail(res, 500, '服务器内部错误');
    res.end();
  }
});

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

function httpProbe(port, p, timeout = 700) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 6000) buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/* 端口被占用时先确认是不是「本应用」。这能避免同一份数据被两个进程各存一份内存副本。 */
async function probeExisting(port) {
  const hello = await httpProbe(port, '/api/hello');
  if (hello && hello.status === 200) {
    try {
      const j = JSON.parse(hello.body);
      if (j && j.app === 'study-tree') {
        return { kind: 'modern', apiVersion: Number(j.apiVersion) || 0, pid: j.pid };
      }
    } catch (e) { /* 不是我们的接口 */ }
  }
  const page = await httpProbe(port, '/');
  if (page && page.status === 200 && page.body.indexOf('TECH TREE CANVAS') > -1) {
    return { kind: 'legacy' };
  }
  return null;
}

function openUrl(url) {
  if (process.env.NO_OPEN === '1') return;
  if (process.platform === 'win32') exec(`start "" "${url}"`, () => {});
}

function reportExisting(port, found) {
  const url = `http://127.0.0.1:${port}`;
  console.log('');
  if (found.kind === 'modern' && found.apiVersion >= API_VERSION) {
    console.log('  已经有一个study-tree在运行：' + url);
    console.log('  直接用它就行，这个窗口可以关掉。');
    console.log('');
    openUrl(url);
    setTimeout(() => process.exit(0), 400);
    return;
  }
  console.log('  ⚠ 端口 ' + port + ' 上还有一个【旧版本】的study-tree在跑。');
  console.log('    旧进程里的账号、管理员、反馈都是它启动那一刻的快照，');
  console.log('    这就是「没有管理员 / 搜不到好友」的原因。');
  console.log('');
  console.log('  请先关掉原来那个黑色启动窗口（或结束 PID ' + (found.pid || '未知') + '），');
  console.log('  再重新双击 启动.bat。');
  console.log('');
  process.exit(2);
}

function bind(port, onReady, onBusy) {
  function onError(e) {
    server.removeListener('listening', onListening);
    if (e.code === 'EADDRINUSE' && onBusy) return onBusy();
    console.error('[study-tree] 启动失败：' + e.message);
    process.exit(1);
  }
  function onListening() {
    server.removeListener('error', onError);
    onReady(server.address().port);
  }
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

/*
 * Windows 上两个进程可以同时 bind 0.0.0.0:同端口而不报错（SO_REUSEADDR 语义），
 * 结果是新实例看起来启动成功、实际请求都进了旧进程，数据也被两份内存各写一遍。
 * 所以每次启动都先探测端口上是否已经有本应用在应答，绝不盲目 bind。
 */
async function start(port, attempt = 0) {
  if (attempt > 12) {
    console.error('[study-tree] 启动失败：' + START_PORT + ' 起连续端口都不可用');
    process.exit(1);
  }

  const existing = await probeExisting(port);
  if (existing) return reportExisting(port, existing);

  bind(port, (p) => {
    const local = `http://127.0.0.1:${p}`;
    console.log('');
    console.log('  study-tree 已启动');
    console.log('  本机打开：' + local);
    if (HOST === '0.0.0.0') {
      localAddresses().forEach((ip) => console.log('  同一网络：http://' + ip + ':' + p));
    }
    console.log('  数据目录：' + DATA_DIR);
    console.log('  （关闭这个黑窗口就会停止服务）');
    console.log('');
    openUrl(local);
  }, () => start(port + 1, attempt + 1));
}

/* 进程级兜底：避免一次未捕获异常 / 未处理的 Promise 拒绝让整站直接退出 */
process.on('unhandledRejection', (reason) => {
  console.error('[study-tree] 未处理的 Promise 拒绝：', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[study-tree] 未捕获异常，进程即将退出（由 systemd/守护进程重启）：', err && err.stack ? err.stack : err);
  setTimeout(() => process.exit(1), 500);
});

(async () => {
  try {
    await ensureDirs();
    await loadAuth();
    const pruned = pruneSessions();
    if (pruned) console.log('[study-tree] 已清理 ' + pruned + ' 个过期会话');
    setInterval(pruneSessions, 3600 * 1000).unref();
  } catch (e) {
    console.error('[study-tree] 初始化失败：' + e.message);
    process.exit(1);
  }
  start(START_PORT);
})();
