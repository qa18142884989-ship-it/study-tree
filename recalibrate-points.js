#!/usr/bin/env node
/*
 * recalibrate-points.js · 按「时间安排」重算每个用户的科技点
 *
 * 规则（与前端 timerStats 一致）：
 *   本周总空闲(小时) = 7 天可安排时段 − 课表 − 日常安排（重叠只算一次）
 *   本周总量 = 本周总空闲 × 转化率
 *   可用 = max(0, 本周总量 + 任务奖励 − 已用)
 * 若用户还停留在上一周，会先重置：已用/奖励清零、周常任务重置、周号改为本周。
 *
 * 用法：
 *   node recalibrate-points.js           # 执行（每个 tree.json 先备份）
 *   node recalibrate-points.js --dry     # 只预览，不写文件
 *
 * 数据目录默认 ./data，可用 TT_DATA_DIR 指定（服务器上是 /opt/study-tree/data）
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = process.env.TT_DATA_DIR ? path.resolve(process.env.TT_DATA_DIR) : path.join(ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const DRY = process.argv.indexOf('--dry') > -1;
const TIME_SLOTS = [[480, 720], [720, 1020], [1140, 1320]]; // 08-12 / 12-17 / 19-22

function weekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + 'W' + (week < 10 ? '0' + week : week);
}

/* 去重 + 规整，返回 { weeks, schedule, weekKey } */
function normalizeTimer(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const rate = isFinite(Number(t.rate)) ? Math.max(0, Math.min(100, Math.round(Number(t.rate)))) : 50;
  const spent = isFinite(Number(t.spent)) && Number(t.spent) > 0 ? Math.round(Number(t.spent) * 10) / 10 : 0;
  const bonus = isFinite(Number(t.bonus)) && Number(t.bonus) > 0 ? Math.round(Number(t.bonus) * 10) / 10 : 0;
  const weekKeyVal = typeof t.weekKey === 'string' ? t.weekKey : '';

  const cleanCourse = (c) => {
    if (!c || typeof c !== 'object') return null;
    const day = Math.round(Number(c.day));
    const start = Math.round(Number(c.start)), end = Math.round(Number(c.end));
    if (!(day >= 1 && day <= 7) || !isFinite(start) || !isFinite(end) || end <= start) return null;
    return { id: String(c.id || ''), day, start, end, title: String(c.title || '课程').slice(0, 30) };
  };
  const cleanPlan = (p) => {
    if (!p || typeof p !== 'object') return null;
    const start = Math.round(Number(p.start)), end = Math.round(Number(p.end));
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    let days = (Array.isArray(p.days) ? p.days : []).map((x) => Math.round(Number(x))).filter((d) => d >= 1 && d <= 7);
    days = Array.from(new Set(days));
    if (!days.length) days = [1, 2, 3, 4, 5, 6, 7];
    return { id: String(p.id || ''), days, start, end, title: String(p.title || '安排').slice(0, 30) };
  };
  const cleanSchedule = (obj) => {
    const seenC = new Set(), seenP = new Set();
    const courses = (Array.isArray(obj && obj.courses) ? obj.courses : []).map(cleanCourse).filter((c) => {
      if (!c) return false;
      const k = c.day + '|' + c.start + '|' + c.end + '|' + c.title;
      if (seenC.has(k)) return false;
      seenC.add(k);
      return true;
    });
    const plans = (Array.isArray(obj && obj.plans) ? obj.plans : []).map(cleanPlan).filter((p) => {
      if (!p) return false;
      const k = p.days.slice().sort().join(',') + '|' + p.start + '|' + p.end + '|' + p.title;
      if (seenP.has(k)) return false;
      seenP.add(k);
      return true;
    });
    return { courses, plans };
  };

  const weeks = {};
  if (t.weeks && typeof t.weeks === 'object') {
    Object.keys(t.weeks).forEach((k) => {
      if (/^\d{4}W\d{2}$/.test(k)) weeks[k] = cleanSchedule(t.weeks[k]);
    });
  }
  // 旧结构迁移：顶层 courses/plans 并入当前周
  const legacy = cleanSchedule({ courses: t.courses, plans: t.plans });
  if (legacy.courses.length || legacy.plans.length) {
    const wk = weekKeyVal || weekKey(new Date());
    if (!weeks[wk]) weeks[wk] = { courses: [], plans: [] };
    weeks[wk].courses = weeks[wk].courses.concat(legacy.courses);
    weeks[wk].plans = weeks[wk].plans.concat(legacy.plans);
  }

  return { rate, spent, bonus, weekKey: weekKeyVal, weeks };
}

/* 某周的总空闲分钟 */
function freeMinutes(sc) {
  let total = 0;
  for (let day = 1; day <= 7; day++) {
    const busy = [];
    (sc.courses || []).forEach((c) => { if (c.day === day) busy.push([c.start, c.end]); });
    (sc.plans || []).forEach((p) => { if (p.days.indexOf(day) > -1) busy.push([p.start, p.end]); });
    busy.sort((a, b) => a[0] - b[0]);
    const merged = [];
    busy.forEach((x) => {
      const last = merged[merged.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else merged.push([x[0], x[1]]);
    });
    TIME_SLOTS.forEach((slot) => {
      let free = slot[1] - slot[0];
      merged.forEach((b) => {
        const s = Math.max(b[0], slot[0]), e = Math.min(b[1], slot[1]);
        if (e > s) free -= (e - s);
      });
      total += Math.max(0, free);
    });
  }
  return total;
}

if (!fs.existsSync(USERS_DIR)) {
  console.log('没有找到 ' + USERS_DIR);
  process.exit(0);
}

const curKey = weekKey(new Date());
let totalUsers = 0, changed = 0;

fs.readdirSync(USERS_DIR).forEach((uid) => {
  const file = path.join(USERS_DIR, uid, 'tree.json');
  if (!fs.existsSync(file)) return;

  let tree;
  try { tree = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(uid + ': 读取失败，跳过'); return; }

  const before = Number(tree.points) || 0;
  const timer = normalizeTimer(tree.timer);

  // 跨周则重置已用/奖励与周常任务
  let rolled = false;
  if (!tree.week || !tree.week.key || tree.week.key !== curKey) {
    rolled = true;
    timer.spent = 0;
    timer.bonus = 0;
    (tree.tasks || []).forEach((t) => { t.done = false; t.doneAt = 0; });
    tree.week = { key: curKey };
  }
  timer.weekKey = curKey;

  // 新的一周若还没排课，继承上一周的课表（与前端 checkWeek 行为一致）
  const emptyNow = !timer.weeks[curKey] ||
    (!timer.weeks[curKey].courses.length && !timer.weeks[curKey].plans.length);
  if (emptyNow) {
    const prevKey = weekKey(new Date(Date.now() - 7 * 86400000));
    const prev = timer.weeks[prevKey];
    if (prev && (prev.courses.length || prev.plans.length)) {
      timer.weeks[curKey] = JSON.parse(JSON.stringify(prev));
    }
  }

  if (!timer.weeks[curKey]) timer.weeks[curKey] = { courses: [], plans: [] };
  const sc = timer.weeks[curKey];
  const freeMin = freeMinutes(sc);
  const totalPts = (freeMin / 60) * (timer.rate / 100);
  const available = Math.max(0, Math.round((totalPts + timer.bonus - timer.spent) * 10) / 10);

  tree.points = available;
  tree.timer = {
    rate: timer.rate,
    courses: [],
    plans: [],
    spent: timer.spent,
    bonus: timer.bonus,
    weekKey: curKey,
    weeks: timer.weeks
  };

  totalUsers++;
  if (Math.abs(available - before) > 0.05) changed++;
  console.log(
    (path.basename(path.dirname(file)) + '  ').slice(0, 12) +
    '空闲 ' + String(Math.round(freeMin / 60 * 10) / 10).padStart(5) + 'h' +
    ' × ' + String(timer.rate).padStart(3) + '% = ' + String(Math.round(totalPts * 10) / 10).padStart(6) +
    '  已用 ' + String(timer.spent).padStart(4) +
    '  科技点 ' + String(before).padStart(6) + ' → ' + String(available).padStart(6) +
    (rolled ? '  [跨周重置]' : '')
  );

  if (DRY) return;
  const bak = file + '.bak-' + Date.now();
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(tree, null, 2));
});

console.log(
  (DRY ? '预览：' : '完成：') + '共 ' + totalUsers + ' 个用户，' +
  changed + ' 个科技点发生变化' + (DRY ? '（未写入）' : '（已备份 .bak-时间戳）')
);
