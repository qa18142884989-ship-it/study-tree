/*
 * seed-blueprints.js —— 内置精选蓝图（种子数据）
 *
 * 用途：为「蓝图市场」预置一批泛用、实用的精选模板，面向大一/大二工科学生。
 *       用户打开网站即可在蓝图市场看到，一键导入到自己的学习树。
 *
 * 运行方式（在项目根目录）：
 *   node seed-blueprints.js
 *
 * 行为：
 *   - 只「追加」不「覆盖」：若某个模板标题已存在于 blueprints.json，则跳过它。
 *   - 每个模板写两份数据：
 *     1) data/blueprints/<id>/blueprint.json  —— 完整快照（市场详情/导入用）
 *     2) data/blueprints.json                 —— 索引条目（市场列表用）
 *   - 全部标记为 public（公开）、ownerName = 官方精选。
 *
 * 说明：本脚本刻意不引入任何第三方依赖，只用 Node 内置模块，与项目「零依赖」理念一致。
 *       id 生成复用服务端的 newId 规则，保证格式一致。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TT_DATA_DIR ? path.resolve(process.env.TT_DATA_DIR) : path.join(__dirname, 'data');
const BP_DIR = path.join(DATA_DIR, 'blueprints');
const BP_FILE = path.join(DATA_DIR, 'blueprints.json');

const BP_CATEGORIES = ['sport', 'study', 'art', 'other'];
const OFFICIAL_OWNER = '官方精选';

function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/*
 * 蓝图评分：与 server.js 的 scoreBlueprint 保持一致，
 * 这样预置模板在市场上显示的分值就准确、无需运行时重算。
 */
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

/*
 * 模板定义格式：
 *   {
 *     title:   蓝图标题（≤40 字）
 *     note:    说明（≤300 字，写清适用人群和内容，方便用户判断要不要导入）
 *     category:'study'|'sport'|'art'|'other'
 *     tree:    学习树结构：父级能力(group) + 子知识点(leaf)，含 cost(小时)、note、前置依赖
 *   }
 *
 * 节点约定：
 *   - kind: 'group' 是父级能力（cost 会被后端置 0），'leaf' 是知识点（cost=学习小时数）
 *   - prereqOf: 表示「该知识点需要先掌握某知识点」，值为目标知识点的 name 引用
 *   - 树结构用嵌套 children 表达，脚本会自动生成 group/leaf、parentId、prereqIds
 */

// 辅助：把嵌套的树定义拍平成后端需要的 nodes 数组
function buildNodes(treeDef) {
  const nodes = [];
  const byName = new Map();
  let seq = 0;

  function makeNode(name, kind, cost, note, parentId, prereqNames) {
    const id = 'seed_' + (seq++);
    const node = {
      id: id, name: name, cost: kind === 'group' ? 0 : cost,
      unlocked: false, kind: kind, parentId: parentId, prereqIds: [], note: note || ''
    };
    nodes.push(node);
    byName.set(name, node);
    return node;
  }

  // 先创建所有节点（两遍：先建 group 和 leaf 拿到引用，再回填 prereqIds）
  function create(nodeDef, parentId) {
    const kind = Array.isArray(nodeDef.children) ? 'group' : 'leaf';
    const cost = kind === 'leaf' ? (nodeDef.cost || 1) : 0;
    const n = makeNode(nodeDef.name, kind, cost, nodeDef.note || '', parentId, []);
    if (Array.isArray(nodeDef.children)) {
      nodeDef.children.forEach((c) => create(c, n.id));
    }
    return n;
  }

  // 树可能有多棵（多个顶层 group）
  treeDef.forEach((root) => create(root, null));

  // 回填 prereqIds（按名字引用）
  nodes.forEach((n) => {
    // 从原始定义里找到 prereqOf 并映射
  });

  return nodes;
}

/*
 * 上面 buildNodes 的回填需要在创建时保留原始定义，这里用更直接的方式：
 * 直接在模板里用「扁平 + 名字引用」定义，脚本统一解析。
 */
function expandTemplate(tpl) {
  const nodes = [];
  const idOf = new Map();   // name -> id
  const leafMeta = new Map(); // name -> { cost, note, prereqOf }
  let seq = 0;
  const next = () => 'seed_' + (seq++);

  // 第一遍：登记所有 group 和 leaf，建立 name->id
  tpl.tree.forEach((root) => {
    const rid = next();
    idOf.set(root.name, rid);
    nodes.push({ id: rid, name: root.name, cost: 0, unlocked: false, kind: 'group', parentId: null, prereqIds: [], note: root.note || '' });
    (root.children || []).forEach((leaf) => {
      const lid = next();
      idOf.set(leaf.name, lid);
      leafMeta.set(leaf.name, { cost: leaf.cost || 1, note: leaf.note || '', prereqOf: leaf.prereqOf || [] });
      nodes.push({ id: lid, name: leaf.name, cost: leaf.cost || 1, unlocked: false, kind: 'leaf', parentId: rid, prereqIds: [], note: leaf.note || '' });
    });
  });

  // 第二遍：回填 prereqIds（名字 -> id），并处理跨 group 的引用
  nodes.forEach((n) => {
    const meta = leafMeta.get(n.name);
    if (!meta) return;
    n.prereqIds = (meta.prereqOf || []).map((nm) => idOf.get(nm)).filter(Boolean);
  });

  return nodes;
}

/* ------------------------------------------------------------------ */
/* 10 个精选模板（面向大一/大二工科生）                                  */
/* ------------------------------------------------------------------ */

const TEMPLATES = [
  {
    title: 'Python 编程入门',
    note: '面向零基础，从语法到面向对象，覆盖大一程序设计课程核心内容。按顺序点亮，每个知识点约 4~6 小时，配合课后练习即可掌握。',
    category: 'study',
    tree: [
      {
        name: 'Python 基础语法',
        note: '变量、数据类型、输入输出',
        children: [
          { name: '变量与数据类型', cost: 4, note: 'int/float/str/bool，类型转换，print 格式化' },
          { name: '流程控制', cost: 6, note: 'if/elif/else、for/while 循环、break 与 continue' },
          { name: '函数与模块', cost: 6, note: 'def、参数与返回值、import、常用内置函数', prereqOf: ['变量与数据类型'] },
          { name: '列表与字典', cost: 6, note: 'list/tuple/dict/set，切片、推导式、常用方法', prereqOf: ['变量与数据类型'] },
          { name: '字符串与文件操作', cost: 5, note: '字符串方法、with open 读写文件、编码', prereqOf: ['变量与数据类型'] }
        ]
      },
      {
        name: '面向对象与进阶',
        note: '类、继承、异常处理',
        children: [
          { name: '类与对象', cost: 6, note: 'class、__init__、实例属性与方法、self' },
          { name: '继承与多态', cost: 5, note: '继承、方法重写、super()', prereqOf: ['类与对象'] },
          { name: '异常处理', cost: 3, note: 'try/except/finally、自定义异常', prereqOf: ['类与对象'] }
        ]
      }
    ]
  },
  {
    title: 'C 语言程序设计基础',
    note: '面向大一工科程序设计课程，覆盖从语法到指针的核心考点。适合配合教材或期末考试复习使用。',
    category: 'study',
    tree: [
      {
        name: 'C 语言基础',
        note: '数据类型、控制流、函数',
        children: [
          { name: '变量、常量与数据类型', cost: 4, note: 'int/float/char、常量、类型转换、格式化输出' },
          { name: '分支与循环', cost: 6, note: 'if/switch、for/while/do-while' },
          { name: '函数与作用域', cost: 5, note: '函数定义与调用、形参实参、局部/全局变量' },
          { name: '数组', cost: 6, note: '一维/二维数组、字符数组与字符串', prereqOf: ['分支与循环'] }
        ]
      },
      {
        name: '指针与结构体',
        note: 'C 语言难点，期末必考',
        children: [
          { name: '指针基础', cost: 8, note: '指针概念、& 与 *、指针运算、指针与数组', prereqOf: ['数组'] },
          { name: '结构体', cost: 6, note: 'struct 定义与使用、typedef、结构体数组' },
          { name: '动态内存分配', cost: 5, note: 'malloc/free、内存泄漏、指针进阶', prereqOf: ['指针基础'] }
        ]
      }
    ]
  },
  {
    title: '数据结构与算法入门',
    note: '工科生必修，覆盖线性结构、树、图与经典算法。适合考研 408 或校招笔试前期打基础。',
    category: 'study',
    tree: [
      {
        name: '线性结构',
        note: '数组、链表、栈、队列',
        children: [
          { name: '数组与链表', cost: 6, note: '顺序存储、单/双链表、增删改查' },
          { name: '栈与队列', cost: 6, note: '栈的 LIFO、队列 FIFO、应用场景', prereqOf: ['数组与链表'] },
          { name: '字符串与 KMP', cost: 8, note: '字符串匹配、next 数组、KMP 算法', prereqOf: ['数组与链表'] }
        ]
      },
      {
        name: '树与图',
        note: '二叉树、遍历、图算法',
        children: [
          { name: '二叉树与遍历', cost: 8, note: '先中后序、层序、递归与非递归' },
          { name: '二叉搜索树与平衡树', cost: 10, note: 'BST、AVL、红黑树概念', prereqOf: ['二叉树与遍历'] },
          { name: '图的存储与遍历', cost: 8, note: '邻接矩阵/表、DFS/BFS' },
          { name: '最短路径', cost: 10, note: 'Dijkstra、Floyd', prereqOf: ['图的存储与遍历'] }
        ]
      },
      {
        name: '经典算法思想',
        note: '排序、查找、递归与动态规划',
        children: [
          { name: '排序算法', cost: 8, note: '冒泡/插入/快排/归并、复杂度分析', prereqOf: ['数组与链表'] },
          { name: '二分查找', cost: 4, note: '二分思想、边界处理', prereqOf: ['排序算法'] },
          { name: '递归与动态规划', cost: 10, note: '递归、记忆化、DP 入门', prereqOf: ['数组与链表'] }
        ]
      }
    ]
  },
  {
    title: '高等数学（上）',
    note: '大一工科必修，覆盖极限、导数、微分、积分核心内容。适合配合教材系统复习，期末冲刺使用。',
    category: 'study',
    tree: [
      {
        name: '极限与连续',
        note: '函数极限与连续性',
        children: [
          { name: '函数与极限', cost: 6, note: '数列极限、函数极限、两个重要极限' },
          { name: '无穷小与等价无穷小', cost: 5, note: '无穷小比较、等价替换', prereqOf: ['函数与极限'] },
          { name: '连续与间断点', cost: 4, note: '连续性、间断点类型', prereqOf: ['函数与极限'] }
        ]
      },
      {
        name: '导数与微分',
        note: '求导、微分中值定理',
        children: [
          { name: '导数与求导法则', cost: 6, note: '导数定义、四则运算、复合函数求导', prereqOf: ['函数与极限'] },
          { name: '高阶导数与隐函数', cost: 5, note: '高阶导数、隐函数、参数方程求导', prereqOf: ['导数与求导法则'] },
          { name: '微分中值定理', cost: 6, note: '罗尔、拉格朗日、柯西定理', prereqOf: ['导数与求导法则'] }
        ]
      },
      {
        name: '积分',
        note: '不定积分、定积分',
        children: [
          { name: '不定积分', cost: 8, note: '换元法、分部积分', prereqOf: ['导数与求导法则'] },
          { name: '定积分', cost: 8, note: '定积分定义、牛顿-莱布尼茨公式', prereqOf: ['不定积分'] },
          { name: '定积分应用', cost: 5, note: '面积、体积、弧长', prereqOf: ['定积分'] }
        ]
      }
    ]
  },
  {
    title: '线性代数',
    note: '大一工科必修，覆盖行列式、矩阵、向量组与线性方程组。适合期末系统复习。',
    category: 'study',
    tree: [
      {
        name: '行列式与矩阵',
        note: '行列式计算与矩阵运算',
        children: [
          { name: '行列式', cost: 6, note: '行列式定义、性质、展开' },
          { name: '矩阵运算', cost: 6, note: '矩阵加减乘、转置、方阵的幂' },
          { name: '逆矩阵与初等变换', cost: 6, note: '逆矩阵、初等行变换、秩', prereqOf: ['矩阵运算'] }
        ]
      },
      {
        name: '向量与线性方程组',
        note: '向量组、线性相关性、解的结构',
        children: [
          { name: '向量组与线性相关性', cost: 8, note: '线性组合、线性相关/无关、极大无关组', prereqOf: ['矩阵运算'] },
          { name: '线性方程组', cost: 8, note: '齐次/非齐次、基础解系、通解', prereqOf: ['向量组与线性相关性'] },
          { name: '特征值与相似对角化', cost: 8, note: '特征值、特征向量、对角化', prereqOf: ['矩阵运算'] }
        ]
      }
    ]
  },
  {
    title: '大学英语四六级备考',
    note: '面向大一/大二四六级备考，按题型拆解，配合真题训练。每个知识点可挂自己的错题笔记。',
    category: 'study',
    tree: [
      {
        name: '词汇与听力',
        note: '单词积累与听力训练',
        children: [
          { name: '核心词汇', cost: 20, note: '四六级高频词，每天背 30~50 个，循环复习' },
          { name: '听力精听训练', cost: 15, note: '短篇新闻、长对话、篇章听力，精听+泛听结合' }
        ]
      },
      {
        name: '阅读与写作',
        note: '阅读理解、翻译与写作',
        children: [
          { name: '阅读理解', cost: 15, note: '选词填空、长篇阅读、仔细阅读，定位+同义替换', prereqOf: ['核心词汇'] },
          { name: '翻译', cost: 10, note: '汉译英，常见句式与固定表达', prereqOf: ['核心词汇'] },
          { name: '写作模板', cost: 8, note: '书信、图表、议论文模板，背范文+仿写' }
        ]
      }
    ]
  },
  {
    title: 'Git 与版本控制入门',
    note: '工科生必备工具，覆盖 Git 核心概念与日常用法。适合第一次接触版本控制的新手。',
    category: 'study',
    tree: [
      {
        name: 'Git 基础',
        note: '版本控制概念与基本命令',
        children: [
          { name: 'Git 是什么与安装', cost: 2, note: '版本控制概念、Git 安装、git config' },
          { name: '仓库与提交', cost: 4, note: 'git init/clone、add、commit、log、status', prereqOf: ['Git 是什么与安装'] },
          { name: '分支与合并', cost: 5, note: 'branch、checkout、merge、解决冲突', prereqOf: ['仓库与提交'] }
        ]
      },
      {
        name: '远程协作',
        note: 'GitHub 与团队协作',
        children: [
          { name: '远程仓库', cost: 4, note: 'remote、push、pull、fetch', prereqOf: ['仓库与提交'] },
          { name: 'Pull Request 与协作流', cost: 5, note: 'fork、PR、code review、rebase', prereqOf: ['远程仓库'] },
          { name: '常见问题排查', cost: 3, note: '撤销修改、reset、reflog、.gitignore', prereqOf: ['分支与合并'] }
        ]
      }
    ]
  },
  {
    title: '计算机考研 408 复习路线',
    note: '面向考研计算机专业基础综合（408），覆盖数据结构、组成原理、操作系统、计算机网络四大模块。适合大二起手规划。',
    category: 'study',
    tree: [
      {
        name: '数据结构',
        note: '408 第一部分，分值高',
        children: [
          { name: '线性表与栈队列', cost: 20, note: '顺序表、链表、栈、队列及应用' },
          { name: '树与图', cost: 25, note: '二叉树、遍历、图算法、最短路径', prereqOf: ['线性表与栈队列'] },
          { name: '查找与排序', cost: 20, note: '二分、哈希、各类排序、复杂度', prereqOf: ['线性表与栈队列'] }
        ]
      },
      {
        name: '计算机组成原理',
        note: '408 第二部分',
        children: [
          { name: '数据的表示与运算', cost: 15, note: '进制、补码、浮点数' },
          { name: '存储系统', cost: 20, note: 'Cache、主存、虚拟内存', prereqOf: ['数据的表示与运算'] },
          { name: '指令系统与CPU', cost: 20, note: '指令格式、寻址、流水线', prereqOf: ['存储系统'] }
        ]
      },
      {
        name: '操作系统',
        note: '408 第三部分',
        children: [
          { name: '进程与线程', cost: 15, note: '进程状态、同步、死锁' },
          { name: '内存管理', cost: 15, note: '分页、分段、虚拟内存', prereqOf: ['进程与线程'] },
          { name: '文件与IO', cost: 10, note: '文件系统、磁盘调度', prereqOf: ['内存管理'] }
        ]
      },
      {
        name: '计算机网络',
        note: '408 第四部分',
        children: [
          { name: '网络体系结构', cost: 12, note: 'OSI、TCP/IP、五层模型' },
          { name: '传输层与应用层', cost: 15, note: 'TCP/UDP、HTTP、DNS', prereqOf: ['网络体系结构'] },
          { name: '网络层与链路层', cost: 15, note: 'IP、路由、以太网', prereqOf: ['网络体系结构'] }
        ]
      }
    ]
  },
  {
    title: '健身增肌入门',
    note: '面向刚接触健身的新手，按部位拆解训练动作，配合饮食与恢复。循序渐进，避免受伤。',
    category: 'sport',
    tree: [
      {
        name: '基础动作',
        note: '复合动作优先',
        children: [
          { name: '深蹲', cost: 3, note: '杠铃/徒手深蹲，动作标准与呼吸' },
          { name: '卧推', cost: 3, note: '杠铃/哑铃卧推，胸部发力' },
          { name: '硬拉', cost: 3, note: '传统/罗马尼亚硬拉，后链发力', prereqOf: ['深蹲'] },
          { name: '引体向上', cost: 3, note: '背部宽度，退阶辅助' }
        ]
      },
      {
        name: '训练计划与恢复',
        note: '分化训练、饮食与休息',
        children: [
          { name: '推拉腿分化', cost: 2, note: 'PPL 三分化，每周循环两次', prereqOf: ['卧推'] },
          { name: '饮食与蛋白质', cost: 2, note: '热量盈余、蛋白质摄入量' },
          { name: '睡眠与恢复', cost: 1, note: '睡眠 7~9 小时，避免过度训练' }
        ]
      }
    ]
  },
  {
    title: '大一新生学习规划',
    note: '面向刚入学的大一新生，从课程学习、工具技能到竞赛规划，帮你建立大学四年的成长路线。',
    category: 'other',
    tree: [
      {
        name: '课程学习',
        note: '大一核心课程',
        children: [
          { name: '高等数学', cost: 30, note: '打好数学基础，为后续专业课铺路' },
          { name: '程序设计基础', cost: 30, note: 'C/Python 入门，培养编程思维' },
          { name: '大学英语', cost: 20, note: '四六级尽早过，别拖到大三' }
        ]
      },
      {
        name: '技能与工具',
        note: '工科生通用技能',
        children: [
          { name: 'Git 与 GitHub', cost: 10, note: '版本控制，尽早建立代码仓库习惯' },
          { name: 'Markdown 与笔记', cost: 5, note: '用笔记沉淀学习内容' },
          { name: '命令行基础', cost: 8, note: 'Linux 常用命令、Shell 基本操作' }
        ]
      },
      {
        name: '竞赛与项目',
        note: '课外提升',
        children: [
          { name: '数学建模', cost: 40, note: '国赛/美赛，锻炼建模与论文写作' },
          { name: '编程竞赛', cost: 40, note: '蓝桥杯/ACM，刷题提升算法', prereqOf: ['程序设计基础'] },
          { name: '个人项目', cost: 50, note: '做一个小项目，写进简历', prereqOf: ['Git 与 GitHub'] }
        ]
      }
    ]
  }
];

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function seed() {
  fs.mkdirSync(BP_DIR, { recursive: true });
  const list = readJson(BP_FILE, []);
  if (!Array.isArray(list)) throw new Error('blueprints.json 格式异常');

  const existingTitles = new Set(list.map((b) => String(b.title || '').trim()));
  let added = 0;
  let skipped = 0;

  for (const tpl of TEMPLATES) {
    if (existingTitles.has(tpl.title.trim())) {
      console.log('  [跳过] 已存在：' + tpl.title);
      skipped++;
      continue;
    }

    const nodes = expandTemplate(tpl);
    const id = newId('bp');
    const now = Date.now();

    const bp = {
      id: id,
      title: tpl.title,
      note: tpl.note,
      ownerId: 'official',
      ownerName: OFFICIAL_OWNER,
      category: tpl.category,
      categoryName: BP_CATEGORIES.indexOf(tpl.category) > -1
        ? { sport: '运动', study: '学习', art: '艺术', other: '其他' }[tpl.category]
        : '其他',
      visibility: 'public',
      treeCategoryName: '',
      sourceNodeId: '',
      createdAt: now,
      updatedAt: now,
      size: 0,
      nodes: nodes,
      files: [],
      images: []
    };
    Object.assign(bp, scoreBlueprint(bp));

    // 1) 完整快照
    const dir = path.join(BP_DIR, id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    writeJson(path.join(dir, 'blueprint.json'), bp);

    // 2) 索引条目（与后端 saveBlueprints 结构一致）
    list.push({
      id: bp.id, title: bp.title, note: bp.note, ownerId: bp.ownerId, ownerName: bp.ownerName,
      category: bp.category, categoryName: bp.categoryName, visibility: bp.visibility,
      sourceNodeId: bp.sourceNodeId, treeCategoryName: bp.treeCategoryName,
      createdAt: bp.createdAt, updatedAt: bp.updatedAt, size: bp.size,
      nodes: bp.nodes, files: bp.files, images: bp.images
    });

    existingTitles.add(tpl.title.trim());
    console.log('  [新增] ' + tpl.title + '（' + nodes.length + ' 个节点，评分 ' + bp.score + '）');
    added++;
  }

  writeJson(BP_FILE, list);
  console.log('');
  console.log('完成：新增 ' + added + ' 个模板，跳过 ' + skipped + ' 个（已存在）。');
  console.log('数据目录：' + DATA_DIR);
}

seed();
