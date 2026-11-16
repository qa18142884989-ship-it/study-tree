# 内置精选蓝图（种子数据）说明

> 文件：`seed-blueprints.js`
> 作用：为蓝图市场预置一批泛用、实用的精选模板，面向大一/大二工科学生。用户打开网站即可在蓝图市场看到，一键导入到自己的学习树。

## 一、内置了哪些模板（10 个）

| 分类 | 模板 | 节点数 |
|---|---|---|
| 学习 | Python 编程入门 | 10 |
| 学习 | C 语言程序设计基础 | 9 |
| 学习 | 数据结构与算法入门 | 13 |
| 学习 | 高等数学（上） | 12 |
| 学习 | 线性代数 | 8 |
| 学习 | 大学英语四六级备考 | 7 |
| 学习 | Git 与版本控制入门 | 8 |
| 学习 | 计算机考研 408 复习路线 | 16 |
| 运动 | 健身增肌入门 | 9 |
| 其他 | 大一新生学习规划 | 12 |

全部为 `public`（公开），发布者显示为「官方精选」。

## 二、三种接入方式（任选其一）

### 方式 1：手动运行一次（最简单）

```bash
# 项目根目录
node seed-blueprints.js
```

运行一次即可，会把模板写入 `data/blueprints/` 和 `data/blueprints.json`。
脚本是**幂等**的：已存在相同标题的模板会自动跳过，不会重复。

### 方式 2：服务启动时自动补齐（推荐）

在 `server.js` 的 `start()` 初始化段，`await loadAuth();` 之后加一行：

```js
await ensureDirs();
await loadAuth();
await seedOfficialBlueprints();   // ← 加这一行（幂等，只补不覆盖）
```

并引入 seed 逻辑。为避免改动侵入，可把 `seed-blueprints.js` 里的 `seed()` 抽成一个可导出的函数，或直接在 `server.js` 里 `require('./seed-blueprints.js')` 后调用其导出的 `seedOfficialBlueprints`。

> 注意：`seed-blueprints.js` 目前是「直接执行」脚本。若要被 require，需把最后的 `seed();` 改成 `if (require.main === module) seed();`，并 `module.exports = { seed }`。

### 方式 3：Docker 启动时执行

在 `Dockerfile` 的 `CMD` 前加：

```dockerfile
RUN node seed-blueprints.js
```

## 三、数据一致性保证

- 节点结构完全复用服务端约定：`group`（父级能力，cost=0）+ `leaf`（知识点，cost=学习小时数）
- `parentId` / `prereqIds` 已正确回填，经服务端 `sanitizeTree` 与导入 DFS 过滤逻辑验证，**无悬空节点**，导入零丢失
- 评分字段用与 `server.js` 的 `scoreBlueprint` 一致的算法预计算，市场显示准确

## 四、后续扩展

- 想加新模板：在 `TEMPLATES` 数组里加一个对象即可，格式见脚本内注释
- 想下架某模板：删掉 `data/blueprints/<id>/` 目录和 `blueprints.json` 对应条目，或加一个"官方下架"标记

## 五、注意

- `data/` 已在 `.gitignore` 中，模板数据本身**不会**被提交到 GitHub；提交的是这个 `seed-blueprints.js` 脚本，部署后由脚本生成数据。
- 模板内容（知识点划分、时长、说明）可按目标人群继续打磨，当前默认面向大一/大二工科生。
