/**
 * Bartle 玩法人格（PLAN-grounding 附：夹带项，最便宜的"治千人一面"）
 *
 * 总帧是「AI 是这个游戏世界的玩家」。同一批玩家拿同一张地图，玩法天差地别——
 * Bartle 四象限（成就/探索/社交/支配）说的就是这件事。anima 里七个人拿的是同一张工具表，
 * 于是选择趋同：全员寒暄、全员干活、全员温吞。
 *
 * **作用面严格限定在"先伸手够哪个工具"**，不碰台词质地：
 * 台词风格已经有人格描写/说话方式/破线三层在管，再加一层只会把人写成标签的平均值。
 * 这里只回答"同样闲着的一小时，这个人更可能去查点什么、去挣点什么、去找个人、还是去拿捏谁"。
 *
 * 缓存纪律：文本 **per 角色恒定**，随身份块进 system prompt 稳定区——不抖前缀。
 * `ANIMA_PLAYSTYLE=0` 整层退场，逐字节回归（A/B 基线）。
 */

export type Playstyle = "achiever" | "explorer" | "socializer" | "killer";

const PLAYSTYLES: Record<Playstyle, string> = {
  achiever:
    "你要看得见的进展。钱、活儿、手艺、地里的收成——能记账的东西才让你安心。" +
    "闲着会不舒服，宁可多跑一趟、多接一单，也不愿意白待着。别人歇脚的时候你在盘算下一步。",
  explorer:
    "你对「这地方还有什么我没翻过」比对人和钱都敏感。没查过的东西想查、没去过的地方想去、" +
    "反常的细节会在你心里挂着。别人聊天的时候你可能正盯着屋里那件东西看。",
  socializer:
    "你要的是人。做什么不重要，和谁一起做才重要。一个人待久了是真的难受，" +
    "会主动去找人；别人的事你会往心里去，也乐意为此绕远路。",
  killer:
    "你要的是在别人身上留下影响——说服、拿捏、赢过、让对方按你的想法动。" +
    "别人的反应本身就是你要的东西。风平浪静的场面让你手痒，你会去推一把看看会怎样。",
};

/** 玩法人格总闸：`ANIMA_PLAYSTYLE=0` 整层退场（逐字节 A/B 基线） */
export function playstyleEnabled(): boolean {
  return process.env.ANIMA_PLAYSTYLE !== "0";
}

export function isPlaystyle(v: unknown): v is Playstyle {
  return typeof v === "string" && v in PLAYSTYLES;
}

/**
 * system prompt 的玩法人格块（per 角色恒定）。
 * 未声明 playstyle 或整层关闭 → undefined（旧角色卡逐字节回归）。
 */
export function buildPlaystyleBlock(playstyle?: string): string | undefined {
  if (!playstyleEnabled() || !isPlaystyle(playstyle)) return undefined;
  return `\n## 你玩这个世界的方式
${PLAYSTYLES[playstyle]}
这不是性格标签，也不影响你怎么说话——它决定的是**同样的处境下你先伸手够哪个工具**。
它是倾向不是规矩：饿了照样得吃饭，该上班照样得上班。`;
}
