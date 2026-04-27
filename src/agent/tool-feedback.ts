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
}

/**
 * 根据工具名 + 失败描述，构造一句具体的 hint。
 * 优先级：模式匹配（高信号） > 工具名通用兜底 > 通用兜底。
 */
export function buildToolFailureHint(ctx: ToolFailureContext): string {
  const { toolName, description, availableTools, currentLocationName } = ctx;

  // 模式 1：go_to 到当前位置
  if (toolName === "go_to" && /已经在/.test(description)) {
    const others = availableTools.filter((n) => n !== "go_to" && n !== "do_nothing");
    if (others.length > 0) {
      return `你已经到了，不需要再 go_to。直接选下面这些工具做点什么：${others.join(", ")}。如果实在没事做，调用 do_nothing。`;
    }
    return "你已经到了，不需要再 go_to。这里没什么事可做时调用 do_nothing 发会儿呆。";
  }

  // 模式 2：go_to 到不存在的地方
  if (toolName === "go_to" && /没有这个地方|unknown_location/.test(description)) {
    return `你传的地点不存在。看 location 参数描述里列出的地点名，挑一个真实存在的；或者调用 do_nothing。`;
  }

  // 模式 3：eat 没指定食物
  if (toolName === "eat" && /没想好吃什么|没有食物/.test(description)) {
    return "调用 eat 时必须在 args 里指定 item_id（你包里或当前商店的食物）。如果没有食物，先 buy 或 go_to 到有食物的地方。";
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
