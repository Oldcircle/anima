/**
 * SmartMockLLM — 按 request.kind 分支返回合法响应的离线 mock（DESIGN-revival §7）
 *
 * 从 stress-sim.test.ts 抽出并升级：
 * - 决策路径保留原启发式（1日/7日压力测试的行为分布基线不动）
 * - 每种 LLM 调用 kind 返回该管线解析器**能吃下**的格式：
 *   decision/conversation → tool call；impression → 总结/观察/标签/态度 行格式；
 *   promise-extract → "承诺: 没有"；transaction-extract → "交割: 没有"；
 *   reflection → 洞察/心情/愿望 行格式；morning-plan → "- " 列表；
 *   observation → 一句白描；director → do_nothing 工具调用
 *   stance-extract → {"stances":[{"kind":"no_stance"}]}（B1 schema 强制默认项）
 * - 剧本化冲突脚本：scriptTalk 给指定角色排队台词（decision/conversation 命中即说），
 *   enqueueKindResponse 对任意 kind 排队覆盖响应——离线彩排立场/冲突链路用
 */

import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "../../src/providers/types.js";

export interface ScriptedTalkEntry {
  /** talk 的目标角色 id */
  target: string;
  /** 台词原文 */
  message: string;
}

export class SmartMockLLM implements LLMProvider {
  readonly id = "smart-mock";
  callCount = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  /** 按 kind 分桶的调用计数（断言"某管线真被调过"用） */
  readonly callsByKind = new Map<string, number>();

  /** 每 kind 的覆盖响应队列（优先级最高） */
  private _kindQueues = new Map<string, LLMResponse[]>();
  /** 剧本化冲突脚本：charId → 待说台词队列 */
  private _talkScripts = new Map<string, ScriptedTalkEntry[]>();

  // ── 剧本接口 ──

  /** 给角色排队台词：该角色下次 decision/conversation 请求且 talk 可用时按序说出 */
  scriptTalk(charId: string, entries: ScriptedTalkEntry[]): void {
    const queue = this._talkScripts.get(charId) ?? [];
    queue.push(...entries);
    this._talkScripts.set(charId, queue);
  }

  /** 对某 kind 排队一次覆盖响应（优先于所有默认分支） */
  enqueueKindResponse(kind: string, content: string, toolCalls: ToolCall[] = []): void {
    const queue = this._kindQueues.get(kind) ?? [];
    queue.push({ content, toolCalls, usage: { inputTokens: 100, outputTokens: 50 } });
    this._kindQueues.set(kind, queue);
  }

  /** 还有没消费完的台词脚本吗（测试断言剧本走完） */
  pendingScriptCount(): number {
    let n = 0;
    for (const q of this._talkScripts.values()) n += q.length;
    return n;
  }

  async chat(request: LLMRequest, _modelId: string): Promise<LLMResponse> {
    this.callCount++;
    const kind = request.kind ?? "decision";
    this.callsByKind.set(kind, (this.callsByKind.get(kind) ?? 0) + 1);

    const prompt = request.messages[request.messages.length - 1]?.content ?? "";
    const promptText = typeof prompt === "string" ? prompt : "";
    const inputTokens = Math.ceil(promptText.length / 4);
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += 30;

    // 0. kind 覆盖队列优先
    const override = this._kindQueues.get(kind)?.shift();
    if (override) return { ...override };

    const respond = (content: string, toolCalls: ToolCall[] = []): LLMResponse => ({
      content,
      toolCalls,
      usage: { inputTokens, outputTokens: 30 },
    });

    const available = (request.tools ?? []).map((t) => t.name);

    // 1. 剧本化台词（decision / conversation 两条路径都吃）
    if (kind === "decision" || kind === "conversation") {
      const tag = request.tag;
      const queue = tag ? this._talkScripts.get(tag) : undefined;
      if (queue && queue.length > 0 && available.includes("talk")) {
        const entry = queue.shift()!;
        return respond(`（照着心里的话说出来）`, [
          { name: "talk", arguments: { target: entry.target, message: entry.message } },
        ]);
      }
    }

    // 2. 按 kind 分支返回该管线解析器能吃下的默认响应
    switch (kind) {
      case "impression":
        return respond(
          [
            "总结：对方看起来还算好相处，没什么特别让人提防的地方",
            "观察：说话的样子挺自然；提到了最近在忙的事",
            "标签：普通镇民",
            "态度：0",
          ].join("\n"),
        );
      case "transaction-extract":
        return respond("交割: 没有");
      case "promise-extract":
        return respond("承诺: 没有");
      case "observation":
        return respond("对方看起来在忙自己的事，没什么特别的。");
      case "reflection":
        return respond(
          [
            "洞察1: 今天大体照常过了一天",
            "不顺: 没有",
            "心情: 平静",
            "愿望: 明天想把手头的活干完",
            "担忧: 没有",
          ].join("\n"),
        );
      case "morning-plan":
        return respond("- 去干活挣点钱\n- 找人说说话");
      case "director": {
        // 默认不干预（合法终止工具）。要彩排硬事件用 enqueueKindResponse("director", ...) 排队
        if (available.includes("do_nothing")) {
          return respond("世界在自然运转，不需要我出手。", [
            { name: "do_nothing", arguments: { reason: "mock 默认不干预" } },
          ]);
        }
        return respond("（无可用工具）");
      }
      case "stance-extract":
        // B1 真 schema（S4）：默认 no_stance（schema 强制默认项）。
        // 彩排立场链路用 enqueueKindResponse("stance-extract", JSON.stringify({stances:[{kind,holder,target,summary,evidence}]}))
        return respond('{"stances":[{"kind":"no_stance"}]}');
      default:
        // decision / conversation / 未知 kind → 原启发式决策
        break;
    }

    const toolCall = this._decide(promptText, available, request);
    return respond(toolCall ? `决定${toolCall.name}` : "无事可做", toolCall ? [toolCall] : []);
  }

  // ── 原启发式决策（自 stress-sim.test.ts 原样迁入，行为分布基线不动） ──

  /** 检查工具是否可用 */
  private _has(available: string[], name: string): boolean {
    return available.includes(name);
  }

  private _decide(prompt: string, available: string[], request: LLMRequest): ToolCall | null {
    if (available.length === 0) return null;

    // 解析需求感受（新系统使用自然语言描述，不再输出数值）
    const isHungry = prompt.includes("胃在抽痛") || prompt.includes("饿得") || prompt.includes("发晕");
    const isMildHungry = isHungry || (prompt.includes("肚子") && prompt.includes("饿"));
    const isTired = prompt.includes("站不稳") || prompt.includes("睁不开") || prompt.includes("眼皮很重");
    const isMildTired = isTired || prompt.includes("有点累") || prompt.includes("哈欠");
    const isLonely = prompt.includes("空荡荡") || prompt.includes("很想找人说说话") || prompt.includes("寂寞");
    const isBored = prompt.includes("闷得发慌") || prompt.includes("无聊");
    const isNight = prompt.includes("深夜") || prompt.includes("正常人都已经睡了");
    const needsBathroom = prompt.includes("憋不住") || prompt.includes("憋得");

    // 解析时间
    const timeMatch = prompt.match(/(\d{2}):(\d{2})/);
    const hour = timeMatch ? Number(timeMatch[1]) : 12;

    // 解析附近的人
    const hasNearby = prompt.includes("你现在看见了谁");
    const hasInbox = prompt.includes("## 有人对你说");

    // 可用地点
    const allLocations = ["cafe", "plaza", "shop", "bar", "beach", "dock", "forest", "farm", "library", "flower_shop", "bakery"];

    // 从 eat 描述中提取第一个食物名称
    const eatItem = this._parseEatItem(request);
    // 从 prompt 中提取角色的 home
    const homeLocMatch = prompt.match(/(\w+_\w+):\s*家/);
    const homeLoc = homeLocMatch?.[1] ?? "home_tomori";

    // 决策优先级（只选可用的工具）

    // 从 buy 描述中也提取物品
    const buyItem = this._parseBuyItem(request);

    // 1. 极度饥饿 → 吃饭（或去能吃的地方）
    if (isHungry) {
      if (this._has(available, "eat") && eatItem) return { name: "eat", arguments: { item: eatItem } };
      if (this._has(available, "cook")) return { name: "cook", arguments: {} };
      if (this._has(available, "buy") && buyItem) return { name: "buy", arguments: { item: buyItem } };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: "shop" } };
    }

    // 2. 上厕所
    if (needsBathroom) {
      if (this._has(available, "use_toilet")) return { name: "use_toilet", arguments: {} };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: homeLoc } };
    }

    // 3. 极度疲惫或深夜 → 睡觉
    if (isTired || isNight) {
      if (this._has(available, "sleep")) return { name: "sleep", arguments: {} };
      if (this._has(available, "rest")) return { name: "rest", arguments: {} };
      if (this._has(available, "nap")) return { name: "nap", arguments: {} };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: homeLoc } };
    }

    // 4. 有信箱消息 → 回复
    if (hasInbox && this._has(available, "talk")) {
      const idMatch = prompt.match(/ID:(\w+)/);
      return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "嗯嗯，说的有道理。" } };
    }

    // 5. 社交需求低 + 有附近的人 → 聊天
    if (isLonely && hasNearby && this._has(available, "talk")) {
      const idMatch = prompt.match(/ID:(\w+)/);
      return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "今天天气不错啊！" } };
    }

    // 6. 上午工作时间 → 员工工具
    const workerTools = ["serve_customer", "make_coffee", "bake", "knead_dough", "shelve_books", "help_reader", "arrange_flowers", "clean_table"];
    if (hour >= 8 && hour < 12 && !isMildTired) {
      const wt = available.filter(t => workerTools.includes(t));
      if (wt.length > 0) return { name: wt[Math.floor(Math.random() * wt.length)]!, arguments: {} };
    }

    // 7. 轻微饥饿 → 吃饭
    if (isMildHungry) {
      if (this._has(available, "eat") && eatItem) return { name: "eat", arguments: { item: eatItem } };
      if (this._has(available, "cook")) return { name: "cook", arguments: {} };
      if (this._has(available, "buy") && buyItem) return { name: "buy", arguments: { item: buyItem } };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: "shop" } };
    }

    // 8. 下午工作
    if (hour >= 13 && hour < 17 && !isMildTired && Math.random() < 0.6) {
      const wt = available.filter(t => workerTools.includes(t));
      if (wt.length > 0) return { name: wt[Math.floor(Math.random() * wt.length)]!, arguments: {} };
    }

    // 9. 社交需求低 → 去公共场所
    if (isLonely && this._has(available, "go_to")) {
      const socialSpots = ["cafe", "plaza", "bar"];
      return { name: "go_to", arguments: { location: socialSpots[Math.floor(Math.random() * socialSpots.length)]! } };
    }

    // 10. 晚上 → 休闲
    if (hour >= 18 && hour < 22) {
      if (this._has(available, "explore") && Math.random() < 0.4) return { name: "explore", arguments: {} };
      if (this._has(available, "read") && Math.random() < 0.4) return { name: "read", arguments: {} };
      if (hasNearby && this._has(available, "talk")) {
        const idMatch = prompt.match(/ID:(\w+)/);
        return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "晚上好！" } };
      }
    }

    // 11. 无聊 → 休闲
    if (isBored) {
      if (this._has(available, "read")) return { name: "read", arguments: {} };
      if (this._has(available, "explore")) return { name: "explore", arguments: {} };
      if (this._has(available, "rest")) return { name: "rest", arguments: {} };
    }

    // 12. 默认：从可用工具中选择合理的（排除需要参数的）
    const needsArgs = new Set(["eat", "buy", "give", "talk", "comfort", "argue", "prepare"]);
    const localTools = available.filter((t) => t !== "go_to" && !needsArgs.has(t));
    if (localTools.length > 0 && Math.random() < 0.6) {
      const tool = localTools[Math.floor(Math.random() * localTools.length)]!;
      return { name: tool, arguments: {} };
    }

    // 13. 去别的地方
    if (this._has(available, "go_to")) {
      return { name: "go_to", arguments: { location: allLocations[Math.floor(Math.random() * allLocations.length)]! } };
    }

    // 14. 兜底：idle
    if (this._has(available, "idle")) return { name: "idle", arguments: {} };
    return { name: available[0]!, arguments: {} };
  }

  /** 从 eat 工具的描述中提取第一个食物名称 */
  private _parseEatItem(request: LLMRequest): string | undefined {
    const eatTool = request.tools?.find(t => t.name === "eat");
    if (!eatTool) return undefined;
    // 描述格式："吃点东西。你身上有：红豆面包（免费）。店里有：三明治（12金币）"
    // 或者 "吃点东西。店里有：白面包（5金币）、红豆面包（8金币）"
    const match = eatTool.description.match(/(?:你身上有|店里有)：([^（(，、]+)/);
    return match?.[1]?.trim();
  }

  /** 从 buy 工具的描述中提取第一个物品名称 */
  private _parseBuyItem(request: LLMRequest): string | undefined {
    const buyTool = request.tools?.find(t => t.name === "buy");
    if (!buyTool) return undefined;
    const match = buyTool.description.match(/店里有：([^（(，、]+)/);
    return match?.[1]?.trim();
  }
}
