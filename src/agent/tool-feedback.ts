/**
 * Tool Feedback — 失败工具调用的 hint 生成器
 *
 * 设计参考 Claude Code（vendor/claude-code）的 `is_error: true` ToolResult 模式：
 * 失败的工具结果不只是错误描述，必须附带"具体该怎么改"的可执行建议，
 * 让模型在同一 turn 内就能 self-correct。
 *
 * 见 PLAN-tool-feedback.md。
 */

export interface ToolFailureContext {
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  availableTools: string[];
  currentLocationName?: string;
  /** 当前可去的地点 [{id, name}]——给 go_to 失败时直接喂 hint，避免 LLM 再瞎猜 id */
  validLocations?: Array<{ id: string; name: string }>;
  /** 当前可买的商品 [{id, name}]——给 buy/eat 失败时直接喂 hint */
  validShopItems?: Array<{ id: string; name: string }>;
}

/**
 * 根据工具名 + 失败描述，构造一句具体的 hint。
 * 优先级：模式匹配（高信号） > 工具名通用兜底 > 通用兜底。
 */
export function buildToolFailureHint(ctx: ToolFailureContext): string {
  const { toolName, description, availableTools, currentLocationName } = ctx;

  // 模式 0：调用了不存在的工具——最常见是 talk 在没人时被乱叫。直接列可用工具。
  // 如果 go_to / buy / eat 在备选里，把它们的合法参数 id 也喂上，避免级联失败。
  if (/不在当前可用列表|不存在的工具|未知行为/.test(description)) {
    const others = availableTools.filter((n) => n !== toolName);
    if (others.length === 0) {
      return `工具 "${toolName}" 现在用不了，且当前没有其他可用工具。调用 do_nothing 跳过这一拍。`;
    }
    const detail: string[] = [];
    if (others.includes("go_to") && ctx.validLocations && ctx.validLocations.length > 0) {
      const list = ctx.validLocations.map((l) => `${l.name}(id=${l.id})`).join(", ");
      detail.push(`go_to 可去：${list}`);
    }
    if ((others.includes("buy") || others.includes("eat")) && ctx.validShopItems && ctx.validShopItems.length > 0) {
      const list = ctx.validShopItems.map((i) => `${i.name}(id=${i.id})`).join(", ");
      detail.push(`buy/eat 可选：${list}`);
    }
    const detailStr = detail.length > 0 ? `\n参数提示：${detail.join("；")}。` : "";
    return `工具 "${toolName}" 现在用不了。当前可用的工具只有：${others.join(", ")}。从这个列表里挑一个，不要再调用 "${toolName}" 或其他未列出的工具。${detailStr}`;
  }

  // 模式 1：go_to 到当前位置
  if (toolName === "go_to" && /已经在/.test(description)) {
    const others = availableTools.filter((n) => n !== "go_to" && n !== "do_nothing");
    if (others.length > 0) {
      return `你已经到了，不需要再 go_to。直接选下面这些工具做点什么：${others.join(", ")}。如果实在没事做，调用 do_nothing。`;
    }
    return "你已经到了，不需要再 go_to。这里没什么事可做时调用 do_nothing 发会儿呆。";
  }

  // 模式 2：go_to 到不存在的地方——直接喂可去地点 id+name，避免 LLM 重试时再瞎猜
  if (toolName === "go_to" && /没有这个地方|unknown_location/.test(description)) {
    if (ctx.validLocations && ctx.validLocations.length > 0) {
      const list = ctx.validLocations.map((l) => `${l.name}(id=${l.id})`).join(", ");
      return `你传的 location="${ctx.args.location}" 不存在。location 参数必须从这个列表里选一个 id：${list}。也可以调用 do_nothing 跳过。`;
    }
    return `你传的地点不存在。看 location 参数描述里列出的地点名，挑一个真实存在的；或者调用 do_nothing。`;
  }

  // 模式 3：eat 没指定食物——喂可吃的物品
  if (toolName === "eat" && /没想好吃什么|没有食物/.test(description)) {
    if (ctx.validShopItems && ctx.validShopItems.length > 0) {
      const list = ctx.validShopItems.map((i) => `${i.name}(id=${i.id})`).join(", ");
      return `调用 eat 时 item_id 必填。当前可吃：${list}（id 用括号里的）。如果都不想吃，调用 do_nothing。`;
    }
    return "调用 eat 时必须在 args 里指定 item_id（你包里或当前商店的食物）。如果没有食物，先 buy 或 go_to 到有食物的地方。";
  }

  // 模式 3.5：buy 物品不存在
  if (toolName === "buy" && /这里没有卖|没有这个物品/.test(description)) {
    if (ctx.validShopItems && ctx.validShopItems.length > 0) {
      const list = ctx.validShopItems.map((i) => `${i.name}(id=${i.id})`).join(", ");
      return `这里没卖你要的东西。当前店里只卖：${list}。换一个 item_id，或 go_to 别的店。`;
    }
    return "这里没你要的物品。换 item_id 或 go_to 别的店。";
  }

  // 模式 4：talk 没附近的人
  if (toolName === "talk" && /附近没有|不在附近/.test(description)) {
    return "你想说话的对象不在身边。先 go_to 到对方所在的地点，或选个 do_nothing/journal 等独自做的事。";
  }

  // 模式 5：参数缺失（任何工具）
  if (/缺少.*参数|missing.*required|参数为空/.test(description)) {
    return `参数不全。检查工具的 parameters 描述，把 required 列的字段都填上再试一次。`;
  }

  // 模式 6：库存不足 / 钱不够
  if (/钱不够|金币不足|库存|没有这个物品/.test(description)) {
    return "前置条件不满足（钱/物）。换一个不需要消耗的工具，或先去赚钱/获取物品。";
  }

  // 通用兜底：列可用工具，建议换一个
  const alt = availableTools.filter((n) => n !== toolName).slice(0, 8);
  const where = currentLocationName ? `你现在在【${currentLocationName}】，` : "";
  if (alt.length > 0) {
    return `${where}换一个工具试试：${alt.join(", ")}。如果实在没合适的，调用 do_nothing。`;
  }
  return `${where}这次调用没成功。换种方式重试，或调用 do_nothing 跳过这一拍。`;
}
