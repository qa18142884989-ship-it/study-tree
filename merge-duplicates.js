#!/usr/bin/env node
/*
 * merge-duplicates.js · 合并同名能力
 *
 * 背景：能力名现在要求全站唯一，但历史上已经建出来的同名能力还在。
 * 这个脚本把同名的第二个、第三个能力合并到第一个上：
 *   - 它们的子节点改挂到保留下来的那个能力
 *   - 多余的重复能力本身被删除
 *
 * 用法：
 *   node merge-duplicates.js          # 真正执行（每个 tree.json 先备份）
 *   node merge-duplicates.js --dry    # 只看会合并什么，不写文件
 *
 * 数据目录默认是 ./data，可用 TT_DATA_DIR 指定（服务器上是 /opt/study-tree/data）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = process.env.TT_DATA_DIR ? path.resolve(process.env.TT_DATA_DIR) : path.join(ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const DRY = process.argv.indexOf('--dry') > -1;

function mergeTree(tree) {
  if (!tree || !Array.isArray(tree.abilities)) return [];
  const groups = tree.abilities.filter((a) => a.kind === 'group');
  const byName = new Map();

  groups.forEach((g) => {
    const key = String(g.name || '').trim().toLowerCase();
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(g);
  });

  const drop = new Set();
  const remap = new Map();
  const log = [];

  byName.forEach((list) => {
    if (list.length < 2) return;
    const keep = list[0];
    list.slice(1).forEach((dup) => {
      drop.add(dup.id);
      remap.set(dup.id, keep.id);
      tree.abilities.forEach((a) => {
        if (a.parentId === dup.id) a.parentId = keep.id;
      });
      log.push('  「' + keep.name + '」合并重复项 ' + dup.id + '(' + dup.categoryId + ')');
    });
  });

  if (drop.size) {
    tree.abilities = tree.abilities.filter((a) => !drop.has(a.id));
    // 原本挂在被删能力上的笔记，改挂到保留下来的那个能力
    (tree.files || []).forEach((f) => {
      if (remap.has(f.nodeId)) f.nodeId = remap.get(f.nodeId);
    });
  }
  return log;
}

if (!fs.existsSync(USERS_DIR)) {
  console.log('没有找到 ' + USERS_DIR);
  process.exit(0);
}

let total = 0;
fs.readdirSync(USERS_DIR).forEach((uid) => {
  const file = path.join(USERS_DIR, uid, 'tree.json');
  if (!fs.existsSync(file)) return;

  let tree;
  try { tree = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(uid + ': 读取失败（' + e.message + '），跳过'); return; }

  const log = mergeTree(tree);
  if (!log.length) return;

  console.log(uid + ':');
  log.forEach((l) => console.log(l));
  total += log.length;

  if (DRY) return;
  const bak = file + '.bak-' + Date.now();
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(tree, null, 2));
  console.log('  已写入，备份：' + path.basename(bak));
});

console.log(DRY
  ? '预览完成：将合并 ' + total + ' 个重名能力（未写入任何文件，去掉 --dry 才会执行）'
  : '完成：共合并 ' + total + ' 个重名能力');
