// flow/analyze.js —— 报告的 LLM 分析器（上帝视角评审，走 qodercli）
// 被 report.js 调用。一次调用出全部分析：实验总结两条 / 两条优化点演化线（转述自迭代原话）/ 每轮模拟问题提醒 + 每轮×每节点分析。
// 定位：报告是检查"每个环节的模拟像不像真实"，不是评实验结果好坏——分析视角全部围绕"模拟得真不真"。
// prompt 只放摘要和任务，明细数据给文件路径让 LLM 自己按需读（qodercli 有文件工具）。
// 结果由 report.js 落盘 runs/report_analysis.json 缓存，--fresh 才重新分析。

import { join } from 'node:path';
import { callLLMJson } from '../llm/qodercli.js';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';

const APP_DIR = new URL('..', import.meta.url).pathname;

// a3 下发是纯代码传导，强规则校验就够了，不做 LLM 分析
const NODE_KEYS = ['a1', 'a2', 'a4', 'a5'];

// rounds: ['r1','r2',...]；roundSummaries: 每轮 {round, rate, broke, dispatched, published}
// checksByRound: runChecks 的结果（失败项塞给 LLM 当线索）
export async function analyze(rounds, roundSummaries, checksByRound) {
  const summaryLines = roundSummaries.map((s) => {
    const failed = (checksByRound[s.round]?.items ?? []).filter((i) => !i.pass);
    return `${s.round}：破零率 ${s.rate}，破零品数 ${s.broke}，下发 ${s.dispatched}，发布 ${s.published}` +
      (failed.length ? `；强规则未通过：${failed.map((f) => f.name).join('、')}` : '');
  });

  const fileList = [
    `${join(APP_DIR, 'data/_ground_truth.json')} —— 每个簇的真相和设计意图（真值，只给你评审用，实验里的角色都看不到它）`,
    `${join(APP_DIR, 'opt_points/init/judgment_experience.md')} —— 初始研判经验`,
    `${join(APP_DIR, 'opt_points/init/incentive_prompt.md')} —— 初始激励口径`,
    `${join(APP_DIR, 'action/env/merchants.json')} —— 商家画像（对照商家决策像不像真商人）`,
    `${join(APP_DIR, 'action/env/consumer_groups.json')} —— 消费者画像（对照购买行为合不合理）`,
    ...rounds.flatMap((r) => {
      const files = [
        `${join(APP_DIR, 'runs', r, 'snap_1_a1_selection.json')} —— ${r} 选品卡（推/不推 + 理由 + 信心）`,
        `${join(APP_DIR, 'runs', r, 'snap_2_a2_incentive.json')} —— ${r} 激励（补贴 + 说辞）`,
        `${join(APP_DIR, 'runs', r, 'snap_4_a4_merchant.json')} —— ${r} 商家决策（含内心 why）`,
        `${join(APP_DIR, 'runs', r, 'snap_5_a5_consumer.json')} —— ${r} 各品销量（含分群明细）`,
      ];
      if (r !== 'r1') files.push(`${join(APP_DIR, 'opt_points', r, 'changelog.md')} —— ${r} 参数包改动记录（自迭代自己写的复盘和改动）`);
      return files;
    }),
  ];

  const prompt = [
    '你是选品世界模型实验的评审（上帝视角，可以看全部内部数据，包括真值）。',
    '这份报告的目的：帮实验主理人检查"每个环节的模拟像不像真实业务"，不是评实验结果的好坏。选品选错了不是问题（真实小二也会错），环节的行为不像真的才是问题。',
    `实验机制：每轮 选品研判→价格激励→下发→商家决策→消费者购买→算破零率（7 日销量 ≥ ${ZERO_BREAK_THRESHOLD} 为破零，分母是下发数）；`,
    '候选机制：平台每轮从 24 簇池按真值类型分层随机圈选 8 个候选（保证每轮有真机会、有陷阱、有模糊题），选品研判只看本轮候选——所以某簇某轮没被推，可能只是不在候选里，不是漏推；评卷的漏推只对本轮候选内的簇算。',
    '跑完一轮，自迭代（只能看业务可见数据，看不到真值/画像/商家内心；知道每轮候选不同，但不知道分层配比）复盘并修改两个参数文件，然后跑下一轮。',
    '',
    '# 各轮结果摘要（已算好）',
    ...summaryLines,
    '',
    '# 明细文件（按需自己读，不用全读；路径 —— 内容说明）',
    ...fileList,
    '',
    '# 你要输出的分析（四块）',
    '1. side_note：对整体实验的总结，只讲两个角度。每个角度输出 summary（一句话下结论）+ points（论据分点，一条只说一件事、带具体证据）：',
    '   - self_iterating：有没有真在做自迭代——改动是不是从上一轮结果学来的、改完下一轮有没有生效、有没有证伪、破零率的变化是真提升还是数字游戏（比如靠少推几个把分母缩小）。每个论据单独一条，不要用「比如 A，B，还有 C」把几件事串成一句',
    '   - to_improve：从实验设计角度看，为了更完善还需要补什么——比如品类数量、轮次数、商家消费者的丰富度、奖励信号的粒度，挑最重要的 2~3 个，一条一个',
    '2. evolution：两条优化点演化线（选品研判经验、价格激励口径）。每一跳（init→r2、r2→r3…）从 changelog 里转述**自迭代自己的话**（它是从业务数据里推出来的，你不要替它下判断、不要把真值口径混进去）。每跳两个字段：',
    '   - changes：数组，它这跳改了几条就给几条，一条一个元素。每条把因果链说完整：遇到什么情况 → 它归因是什么 → 所以怎么改。比如不要写「脚踝带差一单破零就收紧了补贴口径」这种因果断裂的话，要写「脚踝带差一单破零，它归因是补贴给保守了没把实付价压下去，所以把高信心品的补贴改成一次给足」',
    '   - case：这跳最典型的一个触发情况（哪个品什么表现，一句话）',
    '3. rounds.rN.alerts：每轮的模拟问题提醒（1~3 条，没有就给空数组）——只提"环节模拟得不像真实/不符合环境设定"的问题，比如：商家的决策和它的画像矛盾、消费者对降价没反应或反应过度、激励说辞自相矛盾、某个环节的行为换成真人不会这么做。',
    '   两类不要放进提醒：①选品推错了、率没涨这类结果问题；②商家不完全听平台的话（比如定价超出说辞建议的区间）——真实商家本来就会自己拿主意，这是模拟"像真"的表现，不是问题。',
    `4. rounds.rN.nodes：每轮四个节点的分析（${NODE_KEYS.join('/')}，a3 下发是纯代码传导不用分析）。每个节点输出一个数组，每个元素是 {"title":"小标题","text":"分析一两句"}，按下面的固定角度和小标题逐条给，回答"这个角度上模拟得像不像真实"：`,
    '   - a1 选品研判，4 条，小标题依次为：「理由与结论一致」（有没有理由唱衰、结论却推的卡）、「犹豫有表达」（信心值和理由的把握程度对得上吗）、「分国家判断」（有没有看出哪个国家是主力）、「不被虚火骗」（流量高但没人买的品它怎么判的）',
    '   - a2 价格激励，3 条，小标题依次为：「补贴与信心匹配」（信心高的多补了吗、价差大的补够了吗）、「说辞与补贴自洽」（有没有一边给补贴一边劝退）、「定价引导具体」（给出具体数字了吗）',
    '   - a4 商家决策，3 条，小标题依次为：「接拒像真商人」（对照它的主营品类和规模）、「定价有生意逻辑」（贸易型加价、工厂型压价，可以不听平台的但要说得通）、「与画像不矛盾」（比如保守的小商家有没有突然赌新品类）',
    '   - a5 消费者购买，3 条，小标题依次为：「买的人群对」（销量落在该买的人群上了吗）、「价格反应合理」（便宜了买更多、贵了不买）、「销量量级像真」（有没有离谱的大数或全零）',
    '',
    '# 写法要求（非常重要）',
    '- 全部大白话，写给不懂技术的人看：一句话说一件事，不要用分号把几件事拼一句，不要在括号里塞长解释',
    '- 列证据、举例子必须分点：一条一个点（输出成数组元素），禁止在一句话里用「比如 A，B，还有 C」串多个例子',
    '- 不要造黑话缩略语：不说「盘子门槛」，说「竞对销量太小的簇不推」；不说「收紧口径」，说清楚具体收紧成什么样',
    '- 因果链不许断：说一个改动必须带上它的归因（为什么这个现象推出这个改法），读的人不用自己脑补',
    '- 反面例子（禁止这样写）：「需要主理人：自迭代复盘已经发现并修正了，但这是环境设定问题——饱和逻辑太粗暴」——括号套长句、术语堆叠、绕。正确写法：「商家把价格定到了建议价之上，说辞没拦住。这个环节像真的，但说辞的约束力可以再收紧」',
    '- 不要凑数字充篇幅，引用数字只引最关键的一两个',
    '- 有一说一：模拟得像就说像，不像就说哪里不像',
    '',
    '# 输出格式（固定，只输出 JSON，不要其他文字；JSON 字符串值里不要出现英文双引号，引用词语用中文引号「」）',
    '{"side_note":{"self_iterating":{"summary":"一句话结论","points":["论据1（带具体证据）","论据2","..."]},"to_improve":{"summary":"一句话结论","points":["要补的点1","..."]}},',
    '"evolution":{"selection":[{"from":"init","to":"r2","changes":["改动1：情况 → 归因 → 改法","改动2：..."],"case":"最典型的触发情况"}],"incentive":[同结构]},',
    `"rounds":{"r1":{"alerts":["模拟问题提醒（没有就空数组）"],"nodes":{"a1":[{"title":"理由与结论一致","text":"..."},{"title":"犹豫有表达","text":"..."},{"title":"分国家判断","text":"..."},{"title":"不被虚火骗","text":"..."}],"a2":[...3 条],"a4":[...3 条],"a5":[...3 条]}},"r2":{...}}}`,
  ].join('\n');

  return callLLMJson(prompt, {
    label: 'report_analyze',
    logFile: join(APP_DIR, 'runs', 'analyze.log'),
    validate: (o) => {
      for (const k of ['self_iterating', 'to_improve']) {
        const v = o.side_note?.[k];
        if (typeof v?.summary !== 'string' || !v.summary || !Array.isArray(v.points) || v.points.length === 0) {
          throw new Error(`side_note.${k} 需为 {summary, points[]} 结构（结论 + 论据分点）`);
        }
      }
      for (const line of ['selection', 'incentive']) {
        if (!Array.isArray(o.evolution?.[line])) throw new Error(`缺 evolution.${line}`);
        for (const h of o.evolution[line]) {
          if (!Array.isArray(h.changes) || h.changes.length === 0) throw new Error(`evolution.${line} 每跳需含 changes 数组`);
        }
      }
      if (typeof o.rounds !== 'object' || o.rounds === null) throw new Error('缺 rounds');
      for (const r of rounds) {
        if (!Array.isArray(o.rounds[r]?.alerts)) throw new Error(`rounds.${r}.alerts 缺失`);
        for (const k of NODE_KEYS) {
          const v = o.rounds[r]?.nodes?.[k];
          if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x?.title !== 'string' || typeof x?.text !== 'string' || !x.title || !x.text)) {
            throw new Error(`rounds.${r}.nodes.${k} 应为 {title,text} 对象数组（每个角度一条带小标题）`);
          }
        }
      }
    },
  });
}
