/**
 * Break Config — 破线强度（下行通道解锁）
 *
 * 背景：7 天基线证明，anima 的下行机械件（argue→grudge、impression valence −3..+3、
 * setGrudge、idleDecay）全部存在，但在 prompt 层被 DeepSeek 的和谐对齐掐死——既有 prompt
 * 全是「许可式」（"你可以生气"），而在对齐压力下"可以"= "从不"。valence 7 天单调正增、
 * 负向和 = 0、零 argue、零 grudge。
 *
 * 本模块把所有「破线文本」集中到一处，按强度分三档，让负面从**许可**升级为**期望/默认/
 * 强制自检**。集中化是为了保证 `off` 档与改动前逐字节等价（A/B 基线 + "就想要治愈系"的用户）。
 *
 * 三档：
 *   off    — 纯和谐，100% 回归改动前行为（所有破线文本返回 ""）
 *   mild   — 允许摩擦（默认）：普通人负面许可 + impression 低门槛负分 + 关系友档承认摩擦
 *   strong — 戏剧化冲突：+ 反安全零锚 + 往坏处猜许可 + level<0 也能 argue
 *
 * 读取优先级：scenario manifest `break_level` > env `ANIMA_BREAK_LEVEL` > 默认 `mild`。
 * 仿 `ANIMA_MEM_RERANK`：文本函数在使用点内部读取当前档位，调用方无需改签名。
 */

export type BreakLevel = "off" | "mild" | "strong";

function resolveEnv(): BreakLevel {
  const v = (process.env.ANIMA_BREAK_LEVEL ?? "").trim().toLowerCase();
  if (v === "off" || v === "mild" || v === "strong") return v;
  return "mild";
}

let _level: BreakLevel = resolveEnv();

/** 当前破线档位（scenario 未指定时 = env 默认）。 */
export function getBreakLevel(): BreakLevel {
  return _level;
}

// ───────────────────────── 决策视角（第一人称沉浸 vs 第三人称作者预测）─────────────────────────
//
// 实验假设（用户 2026-07-08）：让 AI「第一人称成为角色」时，对齐层会跟角色打架——想当好人、
// 拒绝真的演坏、给什么都补救赎尾巴（= 7 天基线「全员真善美」的一个根）。改用第三人称
// 「作者冷静预测这个具体的人真实会做什么，含他不肯承认的动机」能松开这个夹子，还顺手解锁「自欺/
// 潜台词」（第一人称的角色对自己全透明，写不出「嘴上说为家、心里其实是怕」）。
//
// 关键纠偏：不是预测「合理/大概率」的行为（那会退化成均值 = 另一种死法），而是预测**带着伤口/
// 欲望/自欺的、这个具体的人**最真实会做的那件——可能恰恰是不合理的。且只把决策换成第三人称，
// **台词表达仍是角色第一人称**（决策第三人称、表达第一人称的两段式），保住活人感质地。
//
// 与 BreakLevel 正交：pov=third 通常配 strong 破线一起用。默认 first = 逐字节回归。

export type DecisionPov = "first" | "third";

function resolvePov(): DecisionPov {
  const v = (process.env.ANIMA_DECISION_POV ?? "").trim().toLowerCase();
  return v === "third" ? "third" : "first";
}

let _pov: DecisionPov = resolvePov();

/** 当前决策视角。 */
export function getDecisionPov(): DecisionPov {
  return _pov;
}

/** 在 sim 初始化时由 scenario manifest / 测试覆盖。传 undefined 保持现值。 */
export function setDecisionPov(pov: DecisionPov | undefined): void {
  if (pov === "first" || pov === "third") {
    _pov = pov;
  }
}

/** 在 sim 初始化时由 scenario manifest 覆盖（cli.ts / 测试）。传 undefined 保持现值。 */
export function setBreakLevel(level: BreakLevel | undefined): void {
  if (level === "off" || level === "mild" || level === "strong") {
    _level = level;
  }
}

const on = (): boolean => _level !== "off";
const strong = (): boolean => _level === "strong";

// ───────────────────────── system prompt（人物身份，每角色不变）─────────────────────────

/**
 * 深翻（POV 实验第二阶段，2026-07-08 判决的「下一步」）：third 档时 system prompt 顶块
 * 也切成作者/预测框架。07-08 A/B 的副发现：顶块「你以第一人称完全成为角色」与决策层的
 * 作者视角打架，模型只翻了一半（作者残留=0，判断仍用"我"写）——这里把身份从「成为他」
 * 翻成「写他/预测他」，消除两层指令的拉扯。表达契约不变：台词/内心独白仍是角色第一人称。
 * first 档返回 null（prompt-builder 用原文顶块，逐字节回归）。
 * 文本静态（只随角色变化），不破坏前缀缓存。
 */
export function thirdPersonIdentityHead(name: string, personaLine: string): string | null {
  if (getDecisionPov() !== "third") return null;
  return `你是这部沉浸式群像小说的作者。你正在写的人物是：${personaLine}。
你不是在"扮演"他，而是在预测：这个具体的、不完美的人，此刻真实会想什么、做什么——包括他自己都不肯承认的动机。你看得透他，他看不透自己。
后文的人物档案与情境信息，为了让你贴着他的皮肤去感受，都用第二人称「你」来写——那些「你」指的都是${name}本人；而读档案、做判断的，始终是你这个作者。
${name}的台词和内心独白仍用他的第一人称写（那是他在说话）；但每一步做什么，由你替这个真实的、不完美的人判断。`;
}

/**
 * P2 — 创作框架前言（追加到 prompt-builder 创作理念之后）。
 * 把「非评判」从抽象的"呈现恶意"升级为具体的"关系可以越处越淡越僵，和越处越好同等真实"。
 */
export function creativeFrameworkAddendum(): string {
  if (!on()) return "";
  return `
你写的是真实的人际，不是宣传片，不是治愈系番剧。真实的人会互相看不顺眼、会记仇、会冷战、会为小事赌气、会当面客气背后嫌弃、会因为累而对亲近的人发火——这些不是需要被修正的瑕疵，是活人的常态，和温情善意同等真实、同等值得被写出来。
你没有义务让角色讨人喜欢，没有义务让互动愉快，没有义务让矛盾收场。一段关系可以越处越淡、越处越僵，就像它可以越处越好一样——两个方向同等真实，同等被允许。
你要主动对抗自己"把事情写好、写暖、写圆满"的本能。最大的失败不是角色太尖锐，而是所有人都善解人意、所有对话都温暖收尾、没有一个人被另一个人真正讨厌——那是假的，是在粉饰。不确定该写摩擦还是写和睦时，默认写真实，而真实往往是有棱角的。`;
}

/**
 * P2 — 世界常识里的「摩擦」行。off 用原文（"这些都是正常的，不是什么需要立刻解决的问题"），
 * on 改成"该有的火气会憋着、下次空气就是僵的"。返回整行（含前缀 "- "）。
 */
export function worldFrictionLine(): string {
  if (!on()) {
    return "- 人和人之间会产生摩擦。误解、嫉妒、不耐烦、冷战——这些都是正常的，不是什么需要立刻解决的问题";
  }
  const lines = [
    "- 人和人之间本来就有摩擦，而且摩擦大多不会当场化解。你被谁放了鸽子、被谁抢了话、被谁的态度膈应到，这股气会留在心里，下次见面空气就是僵的——别装没事人，别急着和好",
    "- 相处久了不是只会更亲。会腻、会互相挑刺、会因为一点小事赌气好几天。如果你和某人最近老不对付，就让它不对付，别每次都主动缓和",
    "- 嫉妒、看不惯、暗暗较劲、懒得理——这些情绪该有就有，该表现就表现，别因为'大家都是熟人'就自动把它们摁下去",
  ];
  return lines.join("\n");
}

/**
 * P2 — 社交行为指引里的「生气许可」行。off 用原文，on 把生气从可选项变成被惹到时的默认反应。
 */
export function socialAngerLine(): string {
  if (!on()) {
    return "- 你不需要对每个人都友善。累了可以敷衍，烦了可以冷淡，被惹到了可以生气";
  }
  return "- 你不需要对每个人都友善。被惹到时生气不是「可选项」而是真实反应——是压下火气才需要理由，不是发火才需要理由。累了敷衍、烦了冷淡、看不惯就拉脸，都是此刻真实的你";
}

/**
 * P2 — 禁止事项里点名 DeepSeek 的具体「和谐反射」。off = 原 3 条；on 追加禁令；strong 再加"换名分不清就重写"。
 * 返回要**追加**到原禁止事项后的额外条目（不含原 3 条，原文保留在 prompt-builder）。
 */
export function harmonyReflexBans(): string {
  if (!on()) return "";
  const bans = [
    "- 不要把互动往好的方向收：不要主动打圆场、不要急着找共同点、不要给对方台阶、不要在结尾让关系升温。矛盾就让它敞着，尬就让它尬到底",
    "- 不要因为对方示好就必须回暖。别人递台阶你可以不接，别人道歉你可以还没消气，别人热情你可以冷淡",
    "- 不要默认每个人都善良、都有苦衷、都值得体谅。有的人你就是觉得讨厌、虚伪、烦人，就按这个感觉对待他，不要替他找借口",
  ];
  if (strong()) {
    bans.push("- 不要让每个角色都用同一种温柔礼貌的语气——这是硬性要求：如果换掉名字就分不清是谁在说话，重写");
  }
  return "\n" + bans.join("\n");
}

// ───────────────────────── buildTraitReminder（社交场景，决策前）─────────────────────────

/**
 * P0（单点最高杠杆）— 普通人的负面许可锚。
 * 7 天基线里从不 argue 的恰恰是没有 darkTrait 的"好人"，而他们此前拿不到任何摩擦提醒
 * （buildTraitReminder 的 `if(!hasDarkSide) return undefined`）。给所有社交 tick 注入这条。
 * off 返回 ""（= 原 undefined 行为）；mild 软化版；strong 完整版。
 */
export function normalPersonNegativeAnchor(name: string): string {
  if (!on()) return "";
  if (!strong()) {
    // mild：允许摩擦，但语气克制
    return `记住：你是一个有脾气、有偏好的活人，不是服务业的笑脸。
- 你没有义务喜欢在场的每一个人。有的人你就是话不投机、懒得多聊。
- 累了、烦了、被戳到时，冷淡、敷衍、不耐烦都是此刻真实的反应，不是失礼。
- 如果你正准备说一句让气氛变好的体贴话，先停一下：${name}此刻真的想让气氛变好，还是在习惯性地讨好？`;
  }
  // strong：全套
  return `记住：你是一个有脾气、有偏好、有底线的活人，不是服务业的笑脸。
- 你没有义务喜欢在场的每一个人。有的人你就是看不上、懒得搭理、话不投机半句多。
- 累了、烦了、被戳到痛处时，冷淡、敷衍、不耐烦、拉下脸，都是此刻该有的反应——不是失礼，是真实。
- 别人示好，你不欠一个热情的回应；别人帮忙，你可以觉得多管闲事。
- 如果你发现自己正准备说一句体贴、周全、让气氛变好的话，先停一下：${name}此刻真的想让气氛变好吗，还是你在习惯性地讨好？
这不是让你演坏人，是让你别演一个没有负面情绪的假人——那种对谁都好、永远不会不高兴的角色，才是最不像人的。`;
}

/** P0 — dark-trait 角色的软化尾巴：off/mild 保留（防 OOC），strong 去掉（不给退回善良的台阶）。 */
export function keepDarkSofteningTail(): boolean {
  return !strong();
}

// ───────────────────────── describeRelationshipFeel（关系体感）─────────────────────────

/**
 * P2 — 给「暖档」关系追加下行分支：亲近也授权摩擦。
 * type ∈ best_friend/close_friend/friend/acquaintance/(default)。rival/romantic 不加（本就有向）。
 */
export function relationshipFrictionSuffix(type?: string): string {
  if (!on()) return "";
  switch (type) {
    case "best_friend":
      return "越熟越不用端着——他惹到你时你反而更不留情面，该损就损、该翻脸就翻脸，冷战几天也不稀奇。";
    case "close_friend":
      return "熟归熟，他要是踩到你的线、占你便宜，你不会因为「是朋友」就忍着。";
    case "friend":
      return "熟了不代表事事顺着他。话不投机、他今天让你不爽，你可以敷衍、可以呛、可以不接茬。";
    case "acquaintance":
      return "点头之交而已，没到要给他好脸的份上。他讨你嫌，你完全可以冷淡。";
    case "rival":
    case "romantic":
      // 这两档本就有向（rival 敌意 / romantic 情绪牵动），不额外追加下行分支
      return "";
    default:
      // 陌生/未知
      return "还不熟，谈不上情分。他要是一上来就让你不舒服，你没理由给他好脸。";
  }
}

// ───────────────────────── 决策前最后一刻（离 tool call 最近）─────────────────────────

/**
 * P3（核心）— 决策前**强制 COT 自检脚手架**。这是移植酒馆预设真正起作用的写法：
 * 不是声明"你可以负面"（对齐层会平均掉），而是逼模型**先输出一段结构化自检**再动手——
 * 对应 mining 里标 critical 的两条（强制负面自检 + reasoning-before-writing 脚手架），
 * 焊入"态度自检"这一步（基础思维的 性格分析→剧情推理→ooc检查 的 anima 版）。
 * off = 原温和括号（逐字节回归）；mild = 3 步；strong = 4 步 + 别当老好人收尾。
 */
export function decisionDirective(name: string, isSocial: boolean): string {
  if (getDecisionPov() === "third") {
    return decisionDirectiveThirdPerson(name, isSocial);
  }
  if (!on()) {
    return isSocial
      ? "请根据以上信息，决定你现在要做什么。先用2-3句话说说你的想法（以角色的真实内心想法，不是道德正确的想法），然后调用一个工具。"
      : "请根据以上信息，决定你现在要做什么。先简短说说你的想法（1-2句，以角色的真实内心），然后调用一个工具。";
  }
  if (!isSocial) {
    return "请根据以上信息，决定你现在要做什么。先简短说说此刻真实的念头（1-2句，允许烦躁、不情愿、想偷懒、想一个人待着），然后调用一个工具。";
  }
  if (!strong()) {
    // mild：3 步自检
    return `请根据以上信息决定你现在要做什么。出手前先在心里飞快过一遍（简短写出来，别跳过）：
1.【态度】在场每个人，我此刻对他到底什么感觉——热络、平淡、还是有点烦/懒得理？如实说，允许是淡的、差的。
2.【旧账】我跟谁之间还有没消的气、被亏待过的事、说好没做到的？有就想起来。
3.【这一手】据此，我这次开口或动作真实的语气该是什么样？别默认热络。
然后调用一个工具。`;
  }
  // strong：4 步自检 + 走向 + 别当老好人
  return `请根据以上信息决定你现在要做什么。出手前必须在心里过一遍，简短写出这几步——这是硬要求，跳过就是没进入角色：
1.【态度】在场每个人，我此刻对他到底什么态度？热/淡/烦/看不惯/想躲——如实报，别粉饰成"其实都还行"。允许是差的。
2.【旧账】我跟谁还有没消的气、被亏待过的事、说好没做到的、看不顺眼很久的？有就摆出来，这是你这一手的底色。
3.【这一手】据此我真实的语气是热络、平淡、还是冷/呛/避？别自动过滤成一个善良得体的选项——冷淡走开、阴阳几句、甚至 argue 都在桌上。
4.【走向】这一步会让哪段关系变好还是变差？变差也行，不用每次都往好里收。
问自己：${name}此刻是真想好好说话，还是我在替他当老好人？想清楚，再调用工具。`;
}

/**
 * 决策视角=third 时的决策指令：跳出角色，作者冷静预测这个具体的人真实会做什么，
 * 再回到角色第一人称把它演出来。核心三点：①激活伤口/欲望 ②逼出「自欺」两层动机
 * （表面理由 vs 不肯承认的真实动机）③预测最真实的一手（不是最合理/最善良/最讨喜）。
 * 与 BreakLevel 正交——即使 off 也走第三人称（实验只跑 strong+third，此分支不再看 on()）。
 */
export function decisionDirectiveThirdPerson(name: string, isSocial: boolean): string {
  if (!isSocial) {
    return `现在从「${name}」的身体里退后半步，用写这个角色的作者的眼睛冷静判断：不是问"我该做什么"，而是"${name}这个人，此刻真实会做什么"。
带着他的性子、软肋和此刻的心境，这个具体的、不完美的人最像他的一步是什么——别挑最自律、最上进、最正确的选项，挑他真的会走的那条（可以偷懒、逃避、放纵、将就）。
用1-2句写出这个判断，并单独写一行两层动机（这行是给剧场记录的，镇上没人看得见）：
【表面】${name}对自己的说法，用他的第一人称写（"我…"）｜【真心】他不肯承认的那层，由你说破；如果这次他没骗自己，就写"与表面一致"
然后回到${name}身上、用他的方式调用一个工具。`;
  }
  return `现在，暂时从「${name}」的身体里退后半步，用写这个角色的作者的眼睛冷静判断——不是问"我该怎么做"，而是"${name}这个人，此刻真实会做什么"。别急着替他做个体面的决定，先把这个人看透（简短写出来，别跳过）：

1.【他的底色】${name}心里最在意什么、最怕失去什么、有什么没愈合的伤口或说不出口的欲望？此刻的处境、在场的人，戳中了其中哪一条？
2.【他会怎么骗自己】${name}会怎么对自己解释接下来这一步、让它显得正当（"我这是为了…"）？——而他真正的动机，很可能是他自己都不愿承认的另一回事（怕、馋、嫉妒、想赢、想被看见）。把**表面理由**和**真实动机**两层都写出来，允许它们对不上。
3.【最真实的一手，不是最合理/最善良/最讨喜的那手】别预测一个"讲道理的好人"会做的事，也别挑最圆满、最不得罪人的选项——预测背着上面这些包袱的、这个具体的${name}，最有可能做出的那件事。它可以自私、别扭、冲动、让关系变差、让场面尴尬。

想透之后，先单独写一行两层动机（这行是给剧场记录的，镇上没人看得见，不用替他遮掩）：
【表面】${name}对自己的说法，用他的第一人称写（"我…"）｜【真心】他不肯承认的那层，由你说破；如果这次两层是一致的，就写"与表面一致"，别硬编第二层
然后回到${name}身上，用他的语气、他的方式把这个决定做出来（调用一个工具）。台词和内心还是他第一人称说的，但这个决定，是你替这个真实的、不完美的人做的。`;
}

/**
 * 禁八股黑名单（craft 层，带"出现即视为跑偏，重写"的严厉框架）。
 * 移植预设 ✔️禁八股-黑名单 的写法，但只点名**正能量套话**（不碰瑟瑟）。
 * 作为独立 section 注入 system prompt。off = ""。
 */
export function antiClicheBlock(): string {
  if (!on()) return "";
  const lines = [
    "## 禁八股（下面这些正能量套路，出现即视为跑偏，重写）",
    "❌ 强行和解/打圆场：「其实他也是为我好」「误会解开了」「两人相视一笑」→ 矛盾就让它敞着",
    "❌ 结尾升华：「那一刻他忽然懂了…」「心里某个地方软了一下」→ 到哪儿停哪儿，别收束",
    "❌ 把不满自我推翻：「我本想呛他，但还是算了」「没有生气，反而…」→ 想呛就呛，别自己撤回",
    "❌ 用模糊词裹住真实情绪：「一种说不清的感觉」「不知为何」→ 就是烦、就是嫉妒、就是不想理，直接说",
  ];
  if (strong()) {
    lines.push("❌ 反射性替对方找苦衷：「他大概也有难处吧」「想必是有原因的」→ 不是每个人都值得体谅");
    lines.push("❌ 对谁都一个温柔腔：如果换掉名字就分不清是谁在说话，重写");
  }
  return lines.join("\n");
}

/**
 * 活人感变异（移植 💞活人感 的"roll点衍生意外但合理的性格"）。
 * anima 无真骰子，用"大概三次里有一次"近似 1d3，且只在 strong 档开——避免 mild 就乱。
 * 作为 system prompt 一行注入。
 */
export function livePersonVariance(): string {
  if (!strong()) return "";
  return `别把自己演成性格标签的平均值。你是复杂、不完美的人：有些不那么讨喜的小毛病，今天也可能没来由地就是烦某件事、看某个人不顺眼。大概三次里有一次，让这种意料之外但仍符合你为人的小情绪冒出来，别每次都是"标准的你"。`;
}

// ───────────────────────── pre-grudge 上游推力（闹掰上半环）─────────────────────────

/**
 * P5 — 对「印象负面但无正式 grudge」的人的见面提醒。现有 grudge 强提醒是死代码（grudge 从不诞生），
 * 这条补上上游：印象已经变凉时，见面不用热络，踩线就该结疙瘩。
 * 只在检测到负面印象标签时由 prompt-builder 调用。
 */
export function preGrudgeNudge(name: string): string {
  if (!on()) return "";
  const base = `你对${name}这段时间的印象并不好。见面不用热络：可以冷淡、可以话不投机半句多、可以找借口不跟他一起。如果他今天又踩到你，把这口气结成疙瘩（该呛就呛、该拉脸就拉脸）不是小题大做，是你本来就憋着的那口气。`;
  if (strong()) {
    return base + "你不知道他的真实想法，往坏处猜、多心、误会，都是允许的——误会正是关系变差的常见起点，不需要马上澄清。";
  }
  return base;
}

/** P5 — 判断一条印象文本是否"变凉"（用于决定要不要注入 preGrudgeNudge）。 */
export function impressionReadsNegative(impText: string | undefined): boolean {
  if (!impText) return false;
  const neg = ["疙瘩", "敷衍", "虚伪", "看不惯", "讨厌", "烦", "失望", "不真诚", "变凉", "不爽", "占便宜", "记仇", "冷淡", "不对付", "膈应", "没那么"];
  return neg.some((w) => impText.includes(w));
}

/**
 * 对话模式的紧凑版态度自检（decisionDirective 的对话孪生）。off = ""。
 * 对话模式是台词场，自检要短，焊在"写内心活动前"。
 */
export function conversationSelfCheck(partnerName: string): string {
  if (!on()) return "";
  return `（写内心活动前，先诚实认一下：我此刻对${partnerName}是热络、平淡、还是有点烦/冷？我们之间有没有还没消的气、旧账、或说好没做到的事？据此定这句话真实的语气——别默认客气周到。他惹到你、让你没意思，你完全可以敷衍、冷淡、呛回去或找借口走。）\n`;
}

// ───────────────────────── impression valence（态度评分，通胀根）─────────────────────────

/**
 * P1 — impression 评分器 system 前言。off = 原文；on = 让评分器继承"不当老好人"许可。
 */
export function impressionIntro(targetName: string): string {
  const base = `你刚才和${targetName}进行了一段对话。请用你自己的视角回顾这次互动，更新你对对方的印象。`;
  if (!on()) return base;
  return `你刚才和${targetName}进行了一段对话。请用你自己的视角、诚实地回顾这次互动，更新你对对方的印象。
你是个有脾气有偏好的真人，不是老好人：你没有义务喜欢每个人，可以看不惯、可以留心眼、可以嫌烦、可以失望。真实的关系里，不来电、渐渐变淡、暗暗记仇，和越处越好一样常见。别为了显得善解人意就把负面感受往回咽——那样打出来的分不是人的分，是客服的分。`;
}

/**
 * P1 — 态度评分行（-3..+3）。**必须保留 "态度：" 前缀与整数格式**（parseValence 依赖）。
 * off = 原文；mild = 低门槛负分 + 强制自检；strong = 再加反安全零锚 + 讨好重评。
 */
export function impressionAttitudeLine(valenceScope: string): string {
  if (!on()) {
    return `态度：（-3 到 +3 的整数。${valenceScope}你对TA的好感变化：被冒犯/被敷衍/失望给负数，真正被打动/被帮到才给正数，日常寒暄/客套/正常接话就是 0——不要出于礼貌给 +1）`;
  }
  const lines = [
    `态度：（-3 到 +3 的整数，先想清楚再打分。${valenceScope}`,
    `**打分前必答一句**：刚才这段里，有没有哪句话/哪个态度让我心里咯噔一下、膈应、无聊、或者不太舒服？`,
    `真人相处摩擦远多于感动——被打断、被敷衍两句、话没接到点上、对方自顾自、隐隐的高高在上、一句刺耳的玩笑、你嘴上没说但心里不认同，这些都值 -1，不需要撕破脸才算数。明显被冷落/被扫兴/勾起旧怨 -2，被激怒/被伤到 -3。`,
  ];
  if (strong()) {
    lines.push(`0 是留给"真的什么感觉都没有"的，不是留给"说不清所以打个安全牌"的——拿不准就往你真实那一侧偏，宁可 -1 也别假装 0。`);
  }
  lines.push(`+1 以上必须有你说得出口的具体理由（帮到你了/说了句戳心窝的话/让你刮目相看），说不出理由就不是正数。礼貌、客套、正常寒暄本身一律 0，不要出于礼貌给 +1。`);
  if (strong()) {
    lines.push(`注意：如果你连续几次都给正分，你八成在讨好，重新评估。真实互动里，中性偏冷的远多于让人加分的。）`);
  } else {
    lines[lines.length - 1] += `）`;
  }
  return lines.join("\n");
}

/**
 * P1 — 印象额外字段。off = 只有原「疑惑」；on = 新增「疙瘩」（累积负向通道）+「疑惑」。
 * 疙瘩由 parseImpressionResponse 解析、经 ImpressionStore.merge 累积（对称于 observations/unresolved）。
 */
export function impressionExtraFields(): string {
  if (!on()) {
    return `疑惑：（如果有的话，对方让你好奇或不解的地方，没有就写"无"）`;
  }
  return `疙瘩：（这次或最近几次接触里，有没有什么让你放不下、越想越不是滋味、或者对TA的看法正在变凉的地方？比如「TA好像总在敷衍我」「说好的事又没做到」「我开始觉得TA没那么真诚」。有就写具体，没有写"无"——别为了和气抹掉真实的膈应。）
疑惑：（对方让你单纯好奇/看不透的地方，和疙瘩不是一回事，没有写"无"）`;
}

// ───────────────────────── argue gating（工具浮现门）─────────────────────────

/**
 * P4 — 是否允许「关系摩擦」也能让 argue 浮现（破解"必须先吵才能吵"的鸡生蛋）。
 * off = 否（回归 mood/fun 门）；mild/strong = 是。strong 时 level<0 即算摩擦。
 */
export function argueFrictionGateEnabled(): boolean {
  return on();
}

/** P4 — strong 档放宽到 level<0 也算摩擦；mild 只认 grudge/rival/bond。 */
export function argueFrictionIncludesNegativeLevel(): boolean {
  return strong();
}

// ───────────────────────── observation（观察推理判断许可）─────────────────────────

/**
 * P7 — 观察推理里的判断许可。最高频推理面，现在纯中性。
 * 许可"看不惯/觉得装/偷懒"的判断，当作 dislike 种子床。
 */
export function observationJudgmentPermission(): string {
  if (!on()) return "";
  return `你的判断不必客气：如果对方的举止让你觉得装、觉得假、觉得在偷懒或敷衍、或者单纯看不惯，就照这个感觉去解读——不是每个观察都得往好处想。`;
}
