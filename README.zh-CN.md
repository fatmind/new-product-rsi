# new-product-rsi —— 自迭代「选品世界模型」实验

**RSI** = **R**e**S**earch-**I**ndex：定期跑一轮研究（research），然后指数逐渐平缓（slowing index）收敛。每轮迭代视野变宽，学到的新东西越来越少，系统最终落在一个稳定的策略上——这就是名字的意思。

> 🇺🇸 English version: [README.md](./README.md)

把选品业务建成一张**可模拟、可反向传播、可持续调整的业务计算图**。这是一套小规模的 RL：环境有一套不动的规律，**奖励 = 7 日破零率**，我们回头调链路上能调的地方。

> ⚠️ **这是验证想法的实验，不是要上线的真实系统。** 它只回答一个问题：「前向跑链 → 看破零率 → 沿链反推 → 调策略 → 重跑」这个机制，能不能让破零率持续提升。

## 一句话

把选品业务建成一张可模拟、可反向传播、可持续调整的**业务计算图**。环境有一层不动的规律，**奖励 = 7 日破零率**（下发包中 7 日内销量 ≥ 5 单的占比），我们回头调链路上能调的地方。破零率是**选品质量 × 商家采纳 × 激励政策**多因子合力的结果，不是任何一段单独决定的。

## 模拟的业务

热点大单品（**`google fitbit air`**）带来配件需求。每轮平台：

1. **圈选候选** —— 从 24 个配件簇里分层随机抽 8 个（推 3 / 模糊 2 / 不推 3，种子 = 轮号；优化侧看不到分层）。
2. **① 选品研判**（*可优化*）—— 对每个候选簇读三份数据，判断未来是不是新星。
3. **② 价格激励**（*可优化*）—— 对要推的簇定补贴 + 商家说辞；**ROI 硬上限** = 竞对价格带中位数 × 0.3。
4. **③ 下发**（*固定*）—— 选品卡 + 激励打包，广播给商家。
5. **④ 商家决策**（*环境，固定*）—— 每个商家按画像决定发不发；trust（唯一运行态可变）结算后升降。
6. **⑤ 消费者购买**（*环境，固定*）—— 5 个消费者群算 7 日销量：脚本基准销量 × LLM 口味/价格系数。
7. **结算** —— 算**破零率**（销量 ≥ `ZERO_BREAK_THRESHOLD`=5 单的品 ÷ 下发数），并就地更新商家 trust。

然后**自迭代**复盘已跑轮次（只看业务可见数据——没有真值、画像、商家内心），产出下一轮参数包：更新的**研判经验条目**与**激励口径**。轮次同号绑定：`runs/rN` 用 `opt_points/rN` 跑出来。

### 主干链路（见 `spec/ontology.png`）

```text
热点大单品 ──▶ 配件商品簇 ──▶ 站内/站外销售、站外需求
   │                                        │
   └──▶ ① 选品卡 ──▶ ② 激励 ──▶ ③ 下发包 ──▶ ④ 商家 ──▶ ⑤ 商品销量
                                                                  │
                                                 7 日破零率（奖励）◀─┘
```

## 核心概念

| 概念 | 含义 |
|---|---|
| **本体** | 世界里的名词：热点单品、配件簇、三份数据、选品卡、激励方案、下发包、商家、新商品、消费者群——以及把它们连起来的**业务影响关系**（见 `spec/ontology.md`）。 |
| **动作** | 有输入→输出契约的一步。可优化的：选品研判、价格激励；固定的：下发；环境：商家、消费者。 |
| **业务地图** | 场景特有知识：「3C 消费电子 - 大单品配件」场景及其研判经验条目（自迭代的最小改动单元）。 |
| **环境** | 不动的世界规律：商家画像（类型 / 主营 / GMV / trust）、消费者群画像、数据。运行中不动。 |
| **上帝视角** | `spec/ontology_god.md` + `data/_ground_truth.json`——实验内部设计（数据怎么造、陷阱、画像数值）。绝不进优化循环，有泄漏扫描。 |

## 目录结构

```
spec/                  设计文档（实验设计、本体、业务地图、主链路、上帝视角）
draf/                  设计思考与共识笔记
app/
  ontology/            本体对象 schema 定义（声明式，校验从定义派生）
  flow/                run_round · self_iterate（DFS 剪枝式）· attribution（归因裁据层）· improvement_ledger（改进点台账）· replay（重放诊断，仅展示）· report · analyze · checks · reset
  action/              abstract（接口契约）· system · business · env（商家/消费者群）
  llm/                 LLM 适配层（bin 用 claude code）—— 全部 LLM 调用的唯一出口
  lib/                 公共工具（北京时间、常量、本体上下文、竞对价格带 market）
  scene/               场景资产：业务地图 + 研判经验软链
  data/                热点单品、簇、三份数据（+ generate.js、真值表）
  runs/rN/             执行产物：snap_0..snap_6 + 日志 + attribution.json（归因裁据表），每轮一个目录
  opt_points/          优化点：init/ + 每轮参数包 rN/
```

## 环境要求

- **Node.js ≥ 18**（纯 ESM，无构建链、零依赖，只用 node 内置模块）
- **`claude` 在 PATH 上** —— 每次 LLM 调用直接起 `claude -p`，prompt 经 stdin 传入（`--output-format stream-json --verbose --dangerously-skip-permissions`，无 session、无缓存，每次真调）。全项目时间统一北京时间。

## 用法

```bash
# 跑一轮（有 opt_points/rN 用它，没有用 init；重跑加 --force）
node app/flow/run_round.js r1

# 自迭代：复盘截至 rN 的轮次，产出 opt_points/rN+1
node app/flow/self_iterate.js r1

# 生成实验报告（上帝视角评审，--fresh 才会重新分析）
node app/flow/report.js --fresh

# 开发期重置：清 runs/ 和 opt_points/rN，trust 还原 trust_init
node app/flow/reset.js
```

### 典型循环

```bash
node app/flow/run_round.js r1     # 跑第一轮
node app/flow/self_iterate.js r1  # 复盘 r1 → 产出 opt_points/r2
node app/flow/run_round.js r2     # 用新参数包跑第二轮
# ... 循环 ...
node app/flow/report.js --fresh   # 对全部轮次出上帝视角报告
```

## 归因裁据层（自迭代为什么改成 DFS 剪枝）

自迭代起步后 r1–r5 破零数一直卡在 1–2——多数时候不是策略错，是一个带噪声的破零数字被摊回一整条长链（选哪个簇 → 补贴多少 → 商家定价 → 随机波动 → 破零）去背锅。所以 `self_iterate.js` 重写成**把归因链切短（DFS 剪枝）**：`run_round.js` 每轮用确定性、业务可见判据当场算一张归因表（`runs/rN/attribution.json`），把每个没破零的簇定位到一段——`broke / merchant_not_publish / pricing_dead / pricing / demand`。自迭代只补裁剩的 `demand`（需求/用户群匹配）窄空间，绝不回头重推已被排除的段。立项动机与护栏见 `spec/选品自迭代改进_讨论汇总.md` + `app/flow/attribution.js`/`improvement_ledger.js`/`replay.js` 代码头注释。

**防作弊防火墙（贯穿，不改）**：归因表/台账/重放工具只含业务可见字段（实付、进没进竞对带、可见销量、分群销量、发布行为）——绝不读 `_ground_truth.json`、trust、商家内心 why、消费者画像、上帝侧 alerts；checks.js 对这几份产物做泄漏扫描。字面重放是上帝侧诊断，只给人看、不进优化环（拿它定罪就得看真值 = 泄漏）。

## 两个可优化点（其它全部代码写死）

1. **研判经验** —— 怎么读三份数据、什么值得推（`opt_points/<轮>/judgment_experience.md`，≤ 8 条，E 编号）。自迭代改 `opt_points/rN` 的拷贝，绝不改 `init/`。
2. **激励口径** —— 补多深、说辞什么口径（`opt_points/<轮>/incentive_prompt.md`）。硬约束：补贴 ≤ 竞对价格带中位数 × 0.3；输出格式固定。

**红线**：一轮实验内环境（数据、画像）不动；自迭代只调上面两点、绝不看上帝视角；输出格式与 ROI 上限写死在代码里。

## 文档

- `spec/app_design.md` — 实验设计（四层、主链路、自迭代规则）
- `spec/main_link.md` — 主链路逐动作说明书（含可优化点与约束）
- `spec/ontology.md` — 业务视角本体（可安全喂给 LLM）
- `spec/ontology_god.md` — 上帝视角内部设计（绝不进优化循环）
- `spec/business_map.md` — 场景研判经验条目
