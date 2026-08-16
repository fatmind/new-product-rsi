# 主链路

> 沿主干链路（见 ontology.png），每个动作一份说明书。
> 动作分两类：**可优化**（自迭代时能动的，只有两个）、**固定**（系统传导或环境，一轮实验内不动）。
> 内部状态怎么存、怎么更新是统一的技术设计，单独设计。

---

## 动作定义

| # | 动作 | 类型 |
|---|---|---|
| ① | 选品研判 | 业务动作 + **可优化** |
| ② | 价格激励 | 系统动作 + **可优化** |
| ③ | 下发 | 系统动作 + 不可优化 |
| ④ | 商家决策 | 环境 + 不可优化 |
| ⑤ | 消费者购买 | 环境 + 不可优化 |

一轮的节奏：① → ② → ③ → ④ → ⑤ → 计算破零率，前置依赖数据已提前造好。

---

## ① 选品研判（业务动作 + 可优化）

### 输入
```
本轮候选簇（flow 每轮从 24 簇池分层随机圈选 8 个，种子 = 轮号，落 snap_0.candidates）
on_site_sales / off_site_sales / off_site_demand（按候选簇过滤）
```

### 输出
```
selection_card
```

### 概要逻辑
- 对每个簇都出一张卡，推 / 不推都产出，不推也写清为什么
- 读三份数据，通过 LLM + 研判 prompt，分析这个簇是否有新星机会 —— 站外需求涨、站外销售涨、站内有流量没供给

### 自迭代和约束

#### 优化点 1：研判 prompt
- LLM 模拟人类做选品判断：三份数据怎么解读，推不推、原因、信心度
- 注意：这份内容来源特殊，来自业务地图的研判经验条目（见 business_map.md，人工的 "3C 消费电子 - 大单品配件" 选品经验）；自迭代改的是经验条目，输出格式不许动
- 自迭代约束：仅在 "3C 消费电子 - 大单品配件" 范围下，出海电商

---

## ② 价格激励（系统动作 + 可优化）

### 输入
```
selection_card.reason / selection_card.confidence / selection_card.cluster_id（只收 verdict = 推）
cluster.price_range / off_site_sales.price_band
```

### 输出
```
incentive
```

### 概要逻辑
- 通用逻辑，不挂场景（换个场景这套权衡照用）——LLM 只是实现判断的手段，prompt 是它的可调配置
- 补贴多少，由 LLM 综合判断：选品理由硬不硬（reason）、信心高低（confidence）、竞对卖多少钱（price_band）、簇价位带（price_range），给出 subsidy
- 补贴 ROI 校验：`subsidy ≤ 0.3 × 竞对 price_band 中位数`
- lead（给商家的引导说辞）也由 LLM 生成：结合 reason 和 subsidy 写，平台留调控空间、不承诺死数字

### 自迭代和约束

#### 优化点 1：激励 prompt
- 补贴怎么权衡：reason 强弱、confidence、竞对价格水位各占多少分量；出手保守还是激进
- lead 的口径：保守承诺还是加码引导
- 自迭代约束：
    - ROI 上限约束
    - lead 要参考 subsidy，保持一致

---

## ③ 下发（系统动作 + 不可优化）

### 输入
```
cluster / selection_card / incentive
```

### 输出
```
dispatch_package
```

### 概要逻辑
- 把推的卡、对应激励、簇信息打包成 dispatch_package，广播给全部商家
- 注：若多个商家想发同一个簇，谁先报算谁的

---

## ④ 商家决策（环境 + 不可优化）

### 输入
```
dispatch_package
```

### 输出
```
发 / 不发；发 → product（attrs / price 自定，subsidy 来自激励方案）
```

### 内部状态
- 商家画像：type / top_categories / monthly_gmv 定死
- **trust 是唯一会变的字段**：上轮发的品没破零 trust 降、破零 trust 升，计算完破零率后更新

### 概要逻辑
- LLM 按画像演这个商家：卡的理由信不信、lead 心不心动、簇和自己 top_categories 搭不搭、monthly_gmv / type 有没有余力试新品 → 发不发
- 发则参照簇的 attrs 描述和 price_range 定自己的 attrs / price（type 影响定价：贸易型加价高、工厂型压价低）
- 环境规则：跨品类有能力边界——工厂型只能做产线工艺相近的品（硅胶厂做不了皮具/金属），贸易型可跨但供应链要够得着（主营完全不沾边的拒）；补贴诱人、试错成本低都不能成为跨界理由
- 环境规则：单个商家一轮最多接 2 个新品（精力/资金有限），接满后剩余包流向下一个商家——防止单商家包圆、其他商家和 trust 机制空转
- 环境规则：问商家的顺序每轮随机（固定种子 = 轮号，重跑同轮不变）——真实里推送是广播、谁先响应近似随机；前面的商家拒了的包顺延给后面的商家，直到有人接或问完
- 环境规则：定价不能低于簇价位带下限（那是成本线，卖一单亏一单的事商家不干），也不高于上限 1.3 倍——代码硬校验，防止赔本价绕过价格约束

---

## ⑤ 消费者购买（环境 + 不可优化）

### 输入
```
product.attrs / product.price / product.subsidy（实付价 = price − subsidy）
```

### 输出
```
product.sales_7d
```

### 内部状态
- 5 个消费者群的画像，提前确定，实验执行时不更新

### 概要逻辑
- 两层算销量，7 日窗口一次结算：
  - 第一层 基准（脚本）：基准销量(群g, 品i) = cluster_pv_predict[g][簇] × base_cvr[g]
  - 第二层 修正（LLM）：系数 = LLM(画像：taste / budget_range / price_sensitivity，品：attrs / 实付价 / 竞对中位价)，围绕 1 浮动（契合 ~1.5，不相干 ~0.3），价格在这层一起判
  - 环境规则：消费者会和竞对比价——实付价明显高于竞对同类品中位价（如贵 50%+），就算在预算内也不买（系数压到 0.3 以下）
  - sales_7d(品i) = Σ各群 round(基准 × 系数)，各群销量明细一起输出

---

## 红线

- **实验运行中**环境保持不动：三份数据、商家画像等，一轮实验内不改 —— 中途改了，这轮的破零率就没法比
- 实验跑完发现环境有问题，正常修正，重新跑一轮就行
- 可优化的只有 ①② 列出的优化点；别处没有可调项


## 技术方案

### 目录结构

- app
    - ontology/ 本体对象 schema 定义（声明式定义为主体，校验从定义派生）
    - flow/ 业务主链路：run_round（跑一轮）/ self_iterate（自迭代出下轮参数包）/ reset（开发期重置）/ report（生成 runs/report.html 可视化报告，上帝视角排障用）
    - lib/ 公共工具（北京时间等；全项目时间统一北京时间）
    - action/ 动作定义和实现，动作需要实例化本体一起做
        - abstract/ 每个动作一份接口定义（输入→输出契约，不搞统一基类）
        - system/ 系统动作
        - business/ 业务动作
        - env/ 环境（商家/消费者），注意需多个本体实例化；商家实例含 trust 初始值（唯一轮间可变，flow 结算后就地更新）
    - llm/ qodercli 适配层（全部 LLM 调用的唯一出口）
    - scene/big_item_accessories/ 场景资产（业务地图）
        - flow/ 场景 SOP（当前无特殊步骤，直接走通用 flow，建目录占位，保持结构完整）
        - experience/ 研判经验条目（软链引用 opt_points/init/xx.md 研判经验文件）
    - data/ 大单品、商品簇，以及三份数据（站内销量、站外销量、站外需求），每个数据一个独立文件
    - runs/ 执行过程数据
        - r1/
            - snap_0 初始化时写，只快照本轮会被改的状态（当前只有商家 trust）；data / opt_points 跑动中不会变，不重复拷
            - snap_1_action_xxx 某个 action 执行完立即写，内容 = 该动作的输出对象（增量）
            - snap_2_action_xxx
            - logs/ 当前轮次执行日志（.log 文本，每行一条，北京时间），排查用
        - r2/
    - opt_points/ 优化点 + 轮级可变输入（各动作自己读，flow 不统一注入）
        - init/ 初始值：研判经验、激励 prompt
        - r1/ 第一轮 —— 自迭代开始时才生成（实体拷贝 + 修改，不能动 init）；没有 rN 时 flow 直接用 init 跑
        - r2/ 第二轮

**约定**
1. **轮次同号绑定**：runs/rN 用 opt_points/rN 跑出来；自迭代未开始、没有 rN 时直接用 init 跑，不自动生成 rN
2. **实验运行中的初始环境/数据保持不动**：和红线保持一致
3. **自迭代改拷贝**：优化循环改的是 opt_points/rN 里的实体拷贝，不改 init/，哪轮改了什么，diff rN 和 rN-1 就能看到。

### 开发计划

**技术决策**

- Node.js 纯 JS（ESM），不引构建链，只用 node 内置模块（child_process / fs / path）
- LLM 调用：每次直接起 qodercli 子进程——`qodercli -p "<prompt>" --output-format stream-json --dangerously-skip-permissions`，解析 result 事件拿结果；无 session、无缓存，每次真调
- LLM 结构化输出：prompt 强制只输出 JSON，代码解析 + 按 ontology schema 校验，失败重试（最多 3 次）
- 写快照时机：开跑先写 snap_0，每个动作执行完**立即**写增量快照，LLM 请求/响应**实时**追加 logs/ —— 过程中记录，不攒到最后
- 快照写谁：**增量 = 动作的输出**——每个动作产出哪些本体对象，接口契约写死了，执行完把输出原样落盘 snap_N_action_xxx，不做 diff 检测；snap_0 只快照本轮会被改的状态（当前只有商家 trust；data / opt_points / 消费者画像跑动中不变，不重复拷）；结算后补最后一份（破零率 + trust 新值）
- 参数包选择：有 opt_points/rN 用 rN（自迭代开始后才生成）；没有则 flow 直接用 init，不自动生成 rN
- trust 放 action/env/ 商家实例数据里（给初始值）：④商家决策自己读；flow 算完破零率按规则就地更新这个值。trust 不是优化点，自迭代不许手改

**任务（按依赖序）**

| # | 任务 | 验收 |
|---|---|---|
| 1 | llm/ 适配层：起子进程、解析 stream-json、JSON 解析 + 校验重试、实时日志 | 单独脚本真调一次，拿到合法 JSON |
| 2 | ontology/：本体对象 schema | 参考 ontology.md 检查 |
| 3 | opt_points/init/：研判经验（business_map §3 落初版）+ 激励 prompt；scene/experience 软链 | 文件齐、软链通 |
| 4 | action/abstract/：5 个动作各一份接口定义（输入→输出契约） | 和 ①–⑤ 说明书一致 |
| 5 | 动作实现 ①–⑤：各自内部读 opt_points/rN 与 data/；② 的 ROI 校验写死在代码 | 每个动作可单独跑 |
| 6 | data/ 最小 stub：大单品 + 随机选 2 簇 + 三份数据造少量，只为跑通 | 参考 ontology.md 检查 |
| 7 | flow/：串 ①→⑤ + 破零率结算 + trust 更新；每步实时写快照 runs/rN | 与 8 一起验证 |
| 8 | smoke：完整跑一轮 r1 | 能跑通不报错、产物符合 schema 和目录规范；不考虑数据合理性、准确性 |
