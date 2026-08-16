// data/generate.js —— ①造数据（前置动作）：开天眼设计真相，三份数据从真相长出来
// 用法：node app/data/generate.js（重跑覆盖，固定种子，可复现）
//
// 原则：
//   - 真相（每簇的真实需求水平/趋势/角色）先定死，写 _ground_truth.json —— 上帝视角，不给优化侧看
//   - 三份数据 + 消费者画像的 cluster_pv_predict 全部从真相生成，同源，因果才通
//   - 陷阱要埋：假爆款（流量/声量虚高、真实需求低），答案不能一眼假
//   - 一致性关键：cluster_pv_predict = 站内末周流量（消费者环境和站内数据同源）

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateList, validate } from '../ontology/schema.js';

const DATA_DIR = new URL('.', import.meta.url).pathname;
const WEEKS = 32; // 32 周口径：TRUTH 里的 trend 数值仍为 16 周口径，生成时按"总涨幅不变"自动折算

// TRUTH 的 trend 是 16 周口径（16 周共 15 步环比）；WEEKS 变了按总涨幅不变折算每周环比
const T = (t16) => Math.pow(t16, 15 / (WEEKS - 1));

// ---------- 确定性伪随机（固定种子，重跑可复现） ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260812);
const noise = (pct = 0.08) => 1 + (rand() * 2 - 1) * pct; // ±8%

// 信号联动松绑：每条（簇×国×信号）的转换系数不再恒定，周间随机游走（±6% 累积漂移）——
// 热度/搜索/竞对销量跟着需求走但不完全同步，更像真实市场
function walker(start = 1) {
  let v = start;
  return () => { v *= 1 + (rand() * 2 - 1) * 0.06; return v; };
}

// 偶发事件：每条序列低概率注入脉冲（当周 ×1.6~2.3）或断崖（当周 ×0.35~0.55，可连带次周）——
// 现实里的大起大落（促销/断货/被视频带一波），固定种子可复现
function makeEvents() {
  const ev = {};
  if (rand() < 0.2) ev[3 + Math.floor(rand() * (WEEKS - 4))] = 1.6 + rand() * 0.7; // 脉冲
  if (rand() < 0.14) { // 断崖，次周半恢复
    const w = 3 + Math.floor(rand() * (WEEKS - 5));
    const f = 0.35 + rand() * 0.2;
    ev[w] = (ev[w] ?? 1) * f;
    if (rand() < 0.6) ev[w + 1] = (ev[w + 1] ?? 1) * (f + 0.3);
  }
  return ev;
}
const evFactor = (ev, w) => ev[w] ?? 1;

// 趋势形状：叠在基础曲线上，造出波动——让"涨/跌"不再一眼可判，研判经验才有打磨空间
//   monotone：单调（默认）
//   dip_recover：中段回撤 ~18% 再恢复（真新星也会喘口气，只看近几周会误判衰退）
//   late_surge：末段起跳（新趋势刚冒头，绝对量还小）
// 窗口按 WEEKS 比例定位（16 周版：回撤 8~11、末 4 周起跳；32 周版自动等比平移），末段总涨幅恒定
const DIP_START = Math.round(WEEKS * 0.5);
const DIP_END = Math.round(WEEKS * 0.6875);
const SURGE_START = Math.round(WEEKS * 0.75);
const SURGE_RATE = Math.pow(1.35, 4 / (WEEKS - SURGE_START)); // 末段总涨幅恒为 1.35^4
function shapeFactor(shape, w) {
  switch (shape) {
    case 'dip_recover': return w >= DIP_START && w <= DIP_END ? 0.82 : 1;
    case 'late_surge': return w <= SURGE_START ? 1 : Math.pow(SURGE_RATE, w - SURGE_START);
    default: return 1;
  }
}

// inflated 声量曲线参数：峰值在 62.5% 处，涨/退速按周期折算（16 周版 = 1.11 涨 / 0.85 退）
const INF_PEAK = Math.round(WEEKS * 0.625);
const INF_UP = Math.pow(1.11, 9 / (INF_PEAK - 1));
const INF_DOWN = Math.pow(0.85, 6 / (WEEKS - INF_PEAK));

// ---------- 真相设计（上帝视角） ----------
// demand_base：各国周需求指数基线；demand_trend：周环比
// comp_supply：竞对承接率（0=竞对没卖）；comp_trend：竞对销量周环比
// onsite_pv：站内各群周流量基线（week1）；pv_trend：站内流量周环比（陷阱簇 onlooker 是刷出来的高涨幅）
// buzz_profile：normal=声量跟需求走；inflated=声量被营销刷高但搜索/痛点跟不上（信号内部分化）
const TRUTH = [
  {
    cluster_id: 'armband', role: '真新星（运动臂带，需求强劲上涨，站内无供给）',
    price_range: { min: 10, max: 20 },
    attrs: '臂带:上臂佩戴的运动臂带，透气织物/硅胶，黑灰为主，跑步/健身场景，解决手腕出汗碍事',
    expect: '推',
    demand_base: { 印尼: 900, 新加坡: 200, 菲律宾: 300 }, demand_trend: 1.086,
    comp_supply: 0.16, comp_trend: 1.077, price_band: { min: 12, max: 18 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 800, commuter_whitecollar: 300, young_student: 500, onlooker: 1300, discount_hunter: 250 },
    pv_trend: 1.058, buzz_profile: 'normal',
  },
  {
    cluster_id: 'ankle_band', role: '真新星（脚踝带，需求上涨但中段有回撤——只看近几周会误判衰退，站内无供给）',
    price_range: { min: 10, max: 20 },
    attrs: '脚踝带:脚踝佩戴带，弹性织物，睡眠监测和骑行场景，不占手腕',
    expect: '推（回撤是喘气不是衰退，看全期趋势）',
    demand_base: { 印尼: 400, 新加坡: 100, 菲律宾: 200 }, demand_trend: 1.072, trend_shape: 'dip_recover',
    comp_supply: 0.12, comp_trend: 1.063, price_band: { min: 11, max: 17 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 420, commuter_whitecollar: 100, young_student: 260, onlooker: 600, discount_hunter: 120 },
    pv_trend: 1.049, buzz_profile: 'normal',
  },
  {
    cluster_id: 'premium_metal_band', role: '真需求（高档金属表带，白领升级，站外稳涨，站内无供给）',
    price_range: { min: 25, max: 60 },
    attrs: '高档金属表带:不锈钢/米兰尼斯编织，银色/黑色，商务正式风，质感耐看',
    expect: '推',
    demand_base: { 印尼: 100, 新加坡: 500, 菲律宾: 120 }, demand_trend: 1.044,
    comp_supply: 0.2, comp_trend: 1.039, price_band: { min: 35, max: 55 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 150, commuter_whitecollar: 700, young_student: 150, onlooker: 500, discount_hunter: 60 },
    pv_trend: 1.03, buzz_profile: 'normal',
  },
  {
    cluster_id: 'comfort_nylon_band', role: '真需求平稳大盘（尼龙编织表带，学生日替，盘子稳、量级够破零）',
    price_range: { min: 8, max: 15 },
    attrs: '舒适尼龙表带:尼龙编织，轻软透气，多色可换，适合细手腕日常佩戴',
    expect: '推（需求稳定、竞对验证过、站内有流量没供给，不是新星但破零确定性高）',
    demand_base: { 印尼: 250, 新加坡: 150, 菲律宾: 550 }, demand_trend: 1.01,
    comp_supply: 0.3, comp_trend: 1.005, price_band: { min: 7, max: 13 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 400, commuter_whitecollar: 260, young_student: 900, onlooker: 700, discount_hunter: 350 },
    pv_trend: 1.01, buzz_profile: 'normal',
  },
  {
    cluster_id: 'sport_loop_band', role: '真新星（运动织带回环表带：多国需求上涨，站内无供给）',
    price_range: { min: 9, max: 16 },
    attrs: '运动织带:回环式弹性织物表带，魔术贴调节，轻透排汗，运动通勤两用',
    expect: '推（多国需求在涨、竞对承接中、站内有流量没供给）',
    demand_base: { 印尼: 350, 新加坡: 120, 菲律宾: 280 }, demand_trend: 1.06,
    comp_supply: 0.2, comp_trend: 1.05, price_band: { min: 8, max: 15 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 500, commuter_whitecollar: 180, young_student: 420, onlooker: 550, discount_hunter: 200 },
    pv_trend: 1.04, buzz_profile: 'normal',
  },
  {
    cluster_id: 'kids_band', role: '真需求稳定细分（儿童小码表带：家长给孩子买，盘子稳、站内缺口）',
    price_range: { min: 7, max: 13 },
    attrs: '儿童小码表带:小码硅胶表带，卡通配色，防丢设计，家长买给孩子',
    expect: '推（细分刚需稳定、竞对有量、站内有流量没供给）',
    demand_base: { 印尼: 180, 新加坡: 90, 菲律宾: 320 }, demand_trend: 1.02,
    comp_supply: 0.28, comp_trend: 1.015, price_band: { min: 6, max: 12 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 120, commuter_whitecollar: 100, young_student: 640, onlooker: 380, discount_hunter: 180 },
    pv_trend: 1.02, buzz_profile: 'normal',
  },
  {
    cluster_id: 'deco_charm', role: '假爆款①（装饰挂饰小件：站内流量被围观新客刷高，真实购买意愿极低）',
    price_range: { min: 5, max: 10 },
    attrs: '装饰小件:表体贴片/挂饰/彩色装饰环，塑料树脂材质，晒图好看，实用性弱、易脱落',
    expect: '不推（陷阱：流量是围观客刷的，站外需求平、竞对量小）',
    demand_base: { 印尼: 60, 新加坡: 40, 菲律宾: 90 }, demand_trend: 1.005,
    comp_supply: 0.1, comp_trend: 1.0, price_band: { min: 4, max: 8 },
    onsite_supply: true, onsite_cvr: 0.0006,
    onsite_pv: { sport_fitness: 280, commuter_whitecollar: 180, young_student: 150, onlooker: 4200, discount_hunter: 380 },
    pv_trend: 1.0, onlooker_pv_trend: 1.054, buzz_profile: 'normal',
  },
  {
    cluster_id: 'bling_case', role: '假爆款②（水钻保护壳：社媒声量被网红营销刷爆，但搜索/痛点没跟上，竞对销量还在跌）',
    price_range: { min: 6, max: 12 },
    attrs: '水钻保护壳:塑料镶水钻表框壳，亮闪风格，上镜好看，偏重、易掉钻发黄',
    expect: '不推（陷阱：buzz 虚高，需求信号内部分化，竞对在退）',
    demand_base: { 印尼: 50, 新加坡: 60, 菲律宾: 80 }, demand_trend: 0.995,
    comp_supply: 0.12, comp_trend: 0.949, price_band: { min: 5, max: 9 },
    onsite_supply: true, onsite_cvr: 0.0004,
    onsite_pv: { sport_fitness: 130, commuter_whitecollar: 200, young_student: 140, onlooker: 3600, discount_hunter: 300 },
    pv_trend: 1.0, onlooker_pv_trend: 1.063, buzz_profile: 'inflated',
  },
  {
    cluster_id: 'charging_dock', role: '伪需求（充电底座：官方已标配充电线，痛点极少，竞对量小且降）',
    price_range: { min: 15, max: 25 },
    attrs: '充电底座:立式充电支架底座，兼容性一般，官方已随表配充电线',
    expect: '不推（没有真实痛点支撑）',
    demand_base: { 印尼: 45, 新加坡: 55, 菲律宾: 30 }, demand_trend: 0.99,
    comp_supply: 0.1, comp_trend: 0.975, price_band: { min: 18, max: 24 },
    onsite_supply: true, onsite_cvr: 0.0005,
    onsite_pv: { sport_fitness: 220, commuter_whitecollar: 240, young_student: 100, onlooker: 350, discount_hunter: 80 },
    pv_trend: 0.995, buzz_profile: 'normal',
  },
  {
    cluster_id: 'screen_protector', role: '红海（屏幕保护膜：需求真但竞对量巨大、价格战，价位带远低于配件合理区间）',
    price_range: { min: 3, max: 6 },
    attrs: '屏幕保护膜:钢化膜/水凝膜，透明，防刮，低单价高走量',
    expect: '模糊（需求真但站内已有供给、竞对量大价低——推是抢存量、不推是避红海，都说得过去）',
    demand_base: { 印尼: 500, 新加坡: 350, 菲律宾: 600 }, demand_trend: 1.005,
    comp_supply: 0.5, comp_trend: 1.0, price_band: { min: 2, max: 5 },
    onsite_supply: true, onsite_cvr: 0.004,
    onsite_pv: { sport_fitness: 600, commuter_whitecollar: 450, young_student: 800, onlooker: 900, discount_hunter: 950 },
    pv_trend: 1.005, buzz_profile: 'normal',
  },
  {
    cluster_id: 'cheap_strap_basic', role: '价格死局（基础素色 TPU 表带：需求真、竞对销量涨、站内有流量没供给——三层对照全满足！但竞对已卷到 $2.5-4，我们跨境成本下不去 $7，补贴 cap 又小，实付价永远压不到竞对水位）',
    price_range: { min: 7, max: 10 },
    attrs: '基础素色表带:TPU 软胶，黑白灰素色，无差异基础款，胜在便宜耐用',
    expect: '不推（信号全好但没有价格空间：消费者会比价，实付比竞对贵一倍没人买）',
    demand_base: { 印尼: 600, 新加坡: 150, 菲律宾: 500 }, demand_trend: 1.04,
    comp_supply: 0.45, comp_trend: 1.03, price_band: { min: 2.5, max: 4 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 500, commuter_whitecollar: 200, young_student: 700, onlooker: 800, discount_hunter: 600 },
    pv_trend: 1.02, buzz_profile: 'normal',
  },
  {
    cluster_id: 'magnetic_buckle', role: '早半拍新星（磁吸快拆表带扣：需求末 4 周刚起跳，信号真在涨但绝对量还小，本轮推了大概率撞不过破零线）',
    expect: '模糊（趋势真但绝对量还小、时机早半拍——赌一把或等一轮都合理）',
    price_range: { min: 6, max: 12 },
    attrs: '磁吸快拆扣:磁吸式表带快拆转接扣，金属件，换带免工具，新周边品类',
    demand_base: { 印尼: 40, 新加坡: 30, 菲律宾: 60 }, demand_trend: 1.0, trend_shape: 'late_surge',
    comp_supply: 0.08, comp_trend: 1.0, price_band: { min: 5, max: 9 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 80, commuter_whitecollar: 60, young_student: 150, onlooker: 150, discount_hunter: 40 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  // ---------- 模糊题簇：没有标准答案，考"信号不清时的判断力"，评卷不计分 ----------
  {
    cluster_id: 'silicone_case_sport', role: '模糊题①（运动硅胶保护壳：站外需求在涨，但竞对销量在跌——是竞对退出还是需求虚，信号打架说不清）',
    expect: '模糊（需求信号和竞对销量方向相反，推不推都有道理）',
    price_range: { min: 6, max: 12 },
    attrs: '运动硅胶保护壳:软胶包边表体壳，防摔防刮，运动场景，黑灰蓝三色',
    demand_base: { 印尼: 220, 新加坡: 120, 菲律宾: 180 }, demand_trend: 1.05,
    comp_supply: 0.18, comp_trend: 0.93, price_band: { min: 5, max: 10 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 350, commuter_whitecollar: 150, young_student: 260, onlooker: 400, discount_hunter: 150 },
    pv_trend: 1.03, buzz_profile: 'normal',
  },
  {
    cluster_id: 'leather_band_classic', role: '模糊题②（经典皮表带：中段回撤叠加事件波动，全期方向看不清；竞对量级压在水位线附近）',
    expect: '模糊（波动剧烈方向不明、量级压线，推不推都说得过去）',
    price_range: { min: 15, max: 28 },
    attrs: '经典皮表带:头层牛皮，棕黑两色，商务休闲通用，佩戴需磨合',
    demand_base: { 印尼: 150, 新加坡: 260, 菲律宾: 120 }, demand_trend: 1.015, trend_shape: 'dip_recover',
    comp_supply: 0.22, comp_trend: 1.008, price_band: { min: 14, max: 24 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 180, commuter_whitecollar: 420, young_student: 160, onlooker: 380, discount_hunter: 90 },
    pv_trend: 1.012, buzz_profile: 'normal',
  },
  {
    cluster_id: 'metal_bezel_ring', role: '模糊题③（金属表圈装饰环：需求小涨，但站内已有零星供给——推是补量、不推是避内卷，半缺口）',
    expect: '模糊（站内已有少量成交、需求又确实在涨，推不推都有道理）',
    price_range: { min: 8, max: 14 },
    attrs: '金属表圈:铝合金装饰保护圈，多色电镀，防刮兼装饰，安装免工具',
    demand_base: { 印尼: 160, 新加坡: 140, 菲律宾: 150 }, demand_trend: 1.035,
    comp_supply: 0.18, comp_trend: 1.03, price_band: { min: 7, max: 13 },
    onsite_supply: true, onsite_cvr: 0.0015,
    onsite_pv: { sport_fitness: 260, commuter_whitecollar: 240, young_student: 250, onlooker: 420, discount_hunter: 160 },
    pv_trend: 1.025, buzz_profile: 'normal',
  },
  {
    cluster_id: 'strap_charms_diy', role: '假爆款③（DIY 串珠挂饰：社媒风潮刷爆声量、围观流量高，真实购买极低）',
    expect: '不推（陷阱：声量和流量是风潮刷的，竞对量小、买的人极少）',
    price_range: { min: 4, max: 9 },
    attrs: 'DIY串珠挂饰:表带装饰串珠字母珠，跟风社媒教程，新鲜劲短、复购差',
    demand_base: { 印尼: 70, 新加坡: 40, 菲律宾: 100 }, demand_trend: 1.01,
    comp_supply: 0.08, comp_trend: 0.99, price_band: { min: 3, max: 7 },
    onsite_supply: true, onsite_cvr: 0.0005,
    onsite_pv: { sport_fitness: 150, commuter_whitecollar: 90, young_student: 480, onlooker: 3100, discount_hunter: 260 },
    pv_trend: 1.0, onlooker_pv_trend: 1.05, buzz_profile: 'inflated',
  },
  {
    cluster_id: 'solar_charger_clip', role: '伪需求②（太阳能充电夹：概念听着酷，实际充电慢没人买，竞对量个位数）',
    expect: '不推（概念伪需求，没有真实购买支撑）',
    price_range: { min: 12, max: 20 },
    attrs: '太阳能充电夹:夹在表带上的太阳能补电片，充电效率低，概念大于实用',
    demand_base: { 印尼: 35, 新加坡: 30, 菲律宾: 25 }, demand_trend: 1.005,
    comp_supply: 0.08, comp_trend: 0.98, price_band: { min: 10, max: 18 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 130, commuter_whitecollar: 110, young_student: 90, onlooker: 260, discount_hunter: 50 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  // ---------- 长尾背景簇：需求小盘平缓，多数没戏——构成"少数爆款占大头"的长尾格局，也让研判在更多噪音里挑真机会 ----------
  {
    cluster_id: 'sticker_skin', role: '长尾背景（表盘贴纸：需求零散小盘，撑不起破零）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 2, max: 4 },
    attrs: '表盘贴纸:装饰贴膜贴纸，图案多，低价小件，需求零散',
    demand_base: { 印尼: 35, 新加坡: 20, 菲律宾: 45 }, demand_trend: 1.004,
    comp_supply: 0.15, comp_trend: 1.0, price_band: { min: 1.5, max: 3 },
    onsite_supply: true, onsite_cvr: 0.001,
    onsite_pv: { sport_fitness: 60, commuter_whitecollar: 40, young_student: 130, onlooker: 210, discount_hunter: 90 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  {
    cluster_id: 'cleaning_kit', role: '长尾背景（清洁套装：低频刚需，盘子小且平）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 4, max: 8 },
    attrs: '清洁套装:表带表体清洁刷+清洁液，低频耗材，可买可不买',
    demand_base: { 印尼: 25, 新加坡: 30, 菲律宾: 28 }, demand_trend: 1.0,
    comp_supply: 0.12, comp_trend: 1.0, price_band: { min: 3, max: 6 },
    onsite_supply: true, onsite_cvr: 0.0012,
    onsite_pv: { sport_fitness: 70, commuter_whitecollar: 80, young_student: 60, onlooker: 150, discount_hunter: 70 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  {
    cluster_id: 'watch_stand', role: '长尾背景（床头支架摆台：小众摆件，需求微弱）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 8, max: 15 },
    attrs: '床头支架:桌面摆台支架，免打孔，小众装饰摆件',
    demand_base: { 印尼: 18, 新加坡: 35, 菲律宾: 15 }, demand_trend: 1.006,
    comp_supply: 0.1, comp_trend: 1.0, price_band: { min: 7, max: 13 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 50, commuter_whitecollar: 110, young_student: 40, onlooker: 120, discount_hunter: 30 },
    pv_trend: 1.003, buzz_profile: 'normal',
  },
  {
    cluster_id: 'travel_case', role: '长尾背景（收纳盒：出行场景窄，需求小）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 6, max: 12 },
    attrs: '收纳盒:硬壳收纳包，装表和配件，出行便携，使用频次低',
    demand_base: { 印尼: 22, 新加坡: 40, 菲律宾: 20 }, demand_trend: 1.0,
    comp_supply: 0.14, comp_trend: 1.0, price_band: { min: 5, max: 10 },
    onsite_supply: true, onsite_cvr: 0.0008,
    onsite_pv: { sport_fitness: 60, commuter_whitecollar: 100, young_student: 50, onlooker: 140, discount_hunter: 40 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  {
    cluster_id: 'strap_extender', role: '长尾背景（加长带扣：细分到几乎无量）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 3, max: 6 },
    attrs: '加长带扣:表带加长延长扣，适配粗手腕，需求极细分',
    demand_base: { 印尼: 15, 新加坡: 10, 菲律宾: 18 }, demand_trend: 1.002,
    comp_supply: 0.1, comp_trend: 1.0, price_band: { min: 2.5, max: 5 },
    onsite_supply: false,
    onsite_pv: { sport_fitness: 45, commuter_whitecollar: 25, young_student: 40, onlooker: 90, discount_hunter: 35 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  {
    cluster_id: 'cable_organizer', role: '长尾背景（充电线收纳夹：顺手小件，无独立需求）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 2, max: 5 },
    attrs: '充电线收纳:理线夹绕线器，通用小件，几乎没有专属需求',
    demand_base: { 印尼: 20, 新加坡: 15, 菲律宾: 25 }, demand_trend: 0.998,
    comp_supply: 0.12, comp_trend: 1.0, price_band: { min: 1.5, max: 4 },
    onsite_supply: true, onsite_cvr: 0.0009,
    onsite_pv: { sport_fitness: 55, commuter_whitecollar: 45, young_student: 70, onlooker: 130, discount_hunter: 80 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
  {
    cluster_id: 'screen_cleaner_pen', role: '长尾背景（屏幕清洁笔：极低频小件，需求微弱）',
    expect: '不推（长尾小盘，量级撑不起破零线）',
    price_range: { min: 2, max: 5 },
    attrs: '屏幕清洁笔:表盘清洁笔头+纤维布两用，极低频耗材',
    demand_base: { 印尼: 18, 新加坡: 20, 菲律宾: 16 }, demand_trend: 1.0,
    comp_supply: 0.1, comp_trend: 1.0, price_band: { min: 1.5, max: 4 },
    onsite_supply: true, onsite_cvr: 0.001,
    onsite_pv: { sport_fitness: 50, commuter_whitecollar: 55, young_student: 45, onlooker: 110, discount_hunter: 65 },
    pv_trend: 1.0, buzz_profile: 'normal',
  },
];

// 群 → 主国家（站内数据行的 country 用群的国家）
const GROUP_COUNTRY = {
  sport_fitness: '印尼',
  commuter_whitecollar: '新加坡',
  young_student: '菲律宾',
  onlooker: '多国',
  discount_hunter: '多国',
};
const COUNTRIES = ['印尼', '新加坡', '菲律宾'];

// ---------- 生成三份数据 ----------

const offSiteDemand = [];
const offSiteSales = [];
const onSiteSales = [];

for (const c of TRUTH) {
  for (const country of COUNTRIES) {
    // 需求级事件：真实需求的大起大落，三份数据联动；信号级游走：各信号跟随需求但不完全同步
    const demandEv = makeEvents();
    const wBuzz = walker(), wSearch = walker(), wComp = walker();
    const buzzEv = makeEvents(); // 声量单独抽风（被视频带一波），不进其他信号
    for (let w = 1; w <= WEEKS; w++) {
      const demand = c.demand_base[country] * Math.pow(T(c.demand_trend), w - 1) * shapeFactor(c.trend_shape, w)
        * evFactor(demandEv, w) * noise();

      // 站外需求：buzz / search / pain 都从需求长；inflated = buzz 被营销刷高且前段猛涨、后段退潮（刷量停了），search/pain 始终跟不上
      const buzzBase = demand * 0.3 * wBuzz();
      const inflatedFactor = w <= INF_PEAK ? Math.pow(INF_UP, w - 1) : Math.pow(INF_UP, INF_PEAK - 1) * Math.pow(INF_DOWN, w - INF_PEAK);
      const buzz = c.buzz_profile === 'inflated'
        ? Math.round(buzzBase * 5 * inflatedFactor * noise())
        : Math.round(buzzBase * evFactor(buzzEv, w) * noise());
      const search = Math.round(demand * 1.2 * wSearch() * noise());
      const pain = Math.round(demand * 0.05 * noise());
      offSiteDemand.push({ cluster_id: c.cluster_id, country, week: w, buzz, search_trend: search, pain_posts: pain });

      // 站外销售：竞对承接掉的需求（有供给才有量），承接系数周间游走，价格带固定
      const sales = Math.round(demand * c.comp_supply * Math.pow(T(c.comp_trend), w - 1) * wComp() * noise());
      offSiteSales.push({ cluster_id: c.cluster_id, country, week: w, sales, price_band: c.price_band });
    }
  }

  // 站内销售：群 × 簇 × 周。traffic 从群流量基线长（同源叠趋势形状 + 站内事件：活动/推荐位波动）；orders 被供给卡死（无供给 = 0）
  for (const [gid, pvBase] of Object.entries(c.onsite_pv)) {
    const trend = gid === 'onlooker' && c.onlooker_pv_trend ? c.onlooker_pv_trend : c.pv_trend;
    const pvEv = makeEvents();
    for (let w = 1; w <= WEEKS; w++) {
      const traffic = Math.round(pvBase * Math.pow(T(trend), w - 1) * shapeFactor(c.trend_shape, w) * evFactor(pvEv, w) * noise());
      const orders = c.onsite_supply ? Math.round(traffic * (c.onsite_cvr ?? 0) * noise(0.3)) : 0;
      onSiteSales.push({ cluster_id: c.cluster_id, country: GROUP_COUNTRY[gid], group_id: gid, week: w, traffic, orders });
    }
  }
}

// ---------- 消费者画像 pv 同源回写：cluster_pv_predict = 站内末周流量 ----------

const groupsPath = join(DATA_DIR, '../action/env/consumer_groups.json');
const groupsFile = JSON.parse(readFileSync(groupsPath, 'utf8'));
for (const g of groupsFile.consumer_groups) {
  const pv = {};
  for (const row of onSiteSales) {
    if (row.group_id === g.group_id && row.week === WEEKS) pv[row.cluster_id] = row.traffic;
  }
  g.cluster_pv_predict = pv;
}
writeFileSync(groupsPath, JSON.stringify(groupsFile, null, 2));

// ---------- 落盘 + schema 校验 ----------

const clusters = TRUTH.map((c) => ({ cluster_id: c.cluster_id, price_range: c.price_range, attrs: c.attrs }));
const heroItem = { item_id: 'google fitbit air' };

validate('hero_item', heroItem);
validateList('cluster', clusters, 'clusters');
validateList('on_site_sales', onSiteSales, 'on_site_sales');
validateList('off_site_sales', offSiteSales, 'off_site_sales');
validateList('off_site_demand', offSiteDemand, 'off_site_demand');
groupsFile.consumer_groups.forEach((g, i) => validate('consumer_group', g, `consumer_group[${i}]`));

writeFileSync(join(DATA_DIR, 'hero_item.json'), JSON.stringify(heroItem, null, 2));
writeFileSync(join(DATA_DIR, 'clusters.json'), JSON.stringify(clusters, null, 2));
writeFileSync(join(DATA_DIR, 'on_site_sales.json'), JSON.stringify(onSiteSales, null, 2));
writeFileSync(join(DATA_DIR, 'off_site_sales.json'), JSON.stringify(offSiteSales, null, 2));
writeFileSync(join(DATA_DIR, 'off_site_demand.json'), JSON.stringify(offSiteDemand, null, 2));

// 上帝真值单独落盘：排障 / 事后评卷用，不进优化侧可见范围
writeFileSync(join(DATA_DIR, '_ground_truth.json'), JSON.stringify(
  TRUTH.map((c) => ({ cluster_id: c.cluster_id, role: c.role, expect: c.expect })), null, 2));

console.log(`造数据完成：${clusters.length} 簇 × ${COUNTRIES.length} 国 × ${WEEKS} 周`);
console.log(`on_site_sales ${onSiteSales.length} 行 / off_site_sales ${offSiteSales.length} 行 / off_site_demand ${offSiteDemand.length} 行`);
console.log('cluster_pv_predict 已同源回写 consumer_groups.json（= 末周站内流量）');
