/**
 * Gossip System — 八卦传播
 *
 * 事件的 witnesses 可以将消息传播给其他角色。
 * 每个 tick，有目击者的角色有概率将事件作为八卦分享。
 */

import type { WorldEvent } from "../core/event-bus.js";
import type { ShortTermMemory } from "../memory/short-term.js";

export interface GossipItem {
  originalEvent: WorldEvent;
  spreadBy: string;     // 传播者 ID
  spreadTo: string;     // 接收者 ID
  tick: number;
  distortion?: string;  // 八卦可能失真
}

/** 八卦传播概率 */
const GOSSIP_PROBABILITY = 0.15;

/**
 * 处理八卦传播
 * 同一地点的角色中，目击者有概率将事件告诉非目击者
 */
export function processGossipSpread(params: {
  recentEvents: WorldEvent[];
  charactersAtLocation: Map<string, string[]>; // locationId → characterIds
  memory: ShortTermMemory;
  currentTick: number;
}): GossipItem[] {
  const { recentEvents, charactersAtLocation, memory, currentTick } = params;
  const gossips: GossipItem[] = [];

  // 只传播最近 10 个 tick 内的有趣事件
  const interestingEvents = recentEvents.filter((e) => {
    const age = currentTick - e.tick;
    if (age > 10 || age < 1) return false;
    // 只有社交和特殊类型的事件会被传播
    return e.type.startsWith("action.talk") ||
      e.type.startsWith("action.gossip") ||
      e.type.startsWith("action.give_gift") ||
      e.type.startsWith("action.argue") ||
      e.type.startsWith("action.comfort") ||
      e.type.startsWith("action.flirt");
  });

  for (const event of interestingEvents) {
    for (const witness of event.witnesses) {
      // 找到目击者当前所在地点的其他人
      for (const [_locId, charIds] of charactersAtLocation) {
        if (!charIds.includes(witness)) continue;

        for (const listenerId of charIds) {
          if (listenerId === witness) continue;
          if (listenerId === event.actorId) continue; // 不跟当事人说
          if (event.witnesses.includes(listenerId)) continue; // 也看到了

          if (Math.random() < GOSSIP_PROBABILITY) {
            // 传播八卦
            const gossipContent = `听${witness}说：${event.description}`;
            memory.add(listenerId, {
              tick: currentTick,
              type: "observation",
              content: gossipContent,
              importance: 4,
            });

            gossips.push({
              originalEvent: event,
              spreadBy: witness,
              spreadTo: listenerId,
              tick: currentTick,
            });
          }
        }
      }
    }
  }

  return gossips;
}
