/**
 * Memory Narrator — 将机械行为描述转化为自然语言回忆
 *
 * 记忆不是系统日志，是角色的主观回忆。
 * "洗澡梳洗" → "洗了个热水澡，浑身清爽"
 * "买了bread_red_bean" → "在面包店买了个红豆面包"
 */

import { getItemDef } from "../world/item-registry.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";

/**
 * 将行为结果转化为自然语言记忆描述。
 * 调用方传入 tool 名称、参数、结果描述和上下文。
 */
export function narrateAction(params: {
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  locationName?: string;
  characterName?: string;
  success?: boolean;
}): string {
  const { toolName, args, description, locationName, success } = params;

  if (success === false) {
    return `想${description.replace("[失败] ", "")}，但没成功`;
  }

  const loc = locationName ? `在${locationName}` : "";
  const thought = args.thought as string | undefined;

  switch (toolName) {
    // 生活类
    case "sleep":
      return "睡了一觉，醒来精神好多了";
    case "nap":
      return "小睡了一会儿，稍微恢复了点精神";
    case "wash":
      return "洗了个澡，浑身清爽";
    case "use_toilet":
      return "去了趟厕所，舒服多了";
    case "cook": {
      return "在家做了顿饭，虽然费了点力气但吃得很满足";
    }

    // 吃喝
    case "eat": {
      const itemId = args.item as string | undefined;
      if (itemId) {
        const def = getItemDef(itemId);
        const name = def?.name ?? itemId;
        // 判断是买的还是背包里的
        if (description.includes("买了")) {
          return `${loc}买了${name}吃，味道不错`;
        }
        return `吃了${name}`;
      }
      return `${loc}吃了点东西`;
    }

    // 购买
    case "buy": {
      const itemId = args.item as string | undefined;
      if (itemId) {
        const def = getItemDef(itemId);
        const name = def?.name ?? itemId;
        return `${loc}买了${name}`;
      }
      return `${loc}买了点东西`;
    }

    // 送东西
    case "give": {
      const target = args.target as string | undefined;
      const itemId = args.item as string | undefined;
      const def = itemId ? getItemDef(itemId) : undefined;
      const itemName = def?.name ?? itemId ?? "东西";
      return `把${itemName}送给了${target ?? "别人"}`;
    }

    // 移动
    case "go_to": {
      const dest = args.location as string | undefined;
      return `去了${dest ?? "别的地方"}`;
    }

    // 社交
    case "talk": {
      const target = args.target as string | undefined;
      const message = args.message as string | undefined;
      if (target && message) {
        const short = message.length > 30 ? message.slice(0, 30) + "…" : message;
        return `对${target}说：「${short}」`;
      }
      return `和${target ?? "别人"}聊了聊`;
    }
    case "comfort":
      return `安慰了${args.target ?? "别人"}，虽然有点累但觉得做了对的事`;
    case "gossip":
      return `和人聊了会八卦，挺开心的`;
    case "argue":
      return `和${args.target ?? "别人"}吵了一架，心情复杂`;
    case "invite_out":
      return `约了${args.target ?? "别人"}出去`;
    case "share_secret":
      return `跟${args.target ?? "别人"}说了心里话`;

    // 员工工具
    case "serve_customer":
      return `${loc}招呼了客人，赚了点钱`;
    case "make_coffee":
      return `做了一杯咖啡`;
    case "clean_table":
      return `擦了擦桌子，有点无聊`;
    case "knead_dough":
      return `揉了面团，手臂有点酸`;
    case "bake":
      return `烤了一炉面包，香味飘了出来`;
    case "arrange_flowers":
      return `整理了花束，换了水`;
    case "shelve_books":
      return `整理了书架，上了几本归还的书`;
    case "help_reader":
      return `帮人找了本书，聊了几句`;

    // 休闲
    case "journal":
      return "拿出笔记本写了些东西，心里安静了不少";
    case "practice_music":
      return "弹了会吉他，虽然有些音还不太准";
    case "fish":
      return "拿着鱼竿钓了会鱼，挺放松的";
    case "draw":
      return "画了会画，沉浸其中忘了时间";
    case "photograph":
      return "拍了几张照片";
    case "read":
      return `${loc}看了会书，挺安静的`;
    case "swim":
      return "去海里游了泳，很痛快但浑身是盐";
    case "walk":
    case "stroll":
      return `${loc}散了会步`;
    case "sit":
      return `${loc}坐了一会儿，发了会呆`;
    case "explore":
      return `${loc}逛了逛，看看有什么新鲜的`;
    case "collect_shells":
      return "在海边捡了些贝壳";
    case "collect_herbs":
      return "在林子里采了些草药";
    case "stargaze":
      return "看了会星星，夜空很美";

    // 绝境
    case "beg":
      return "向路人乞讨了一点钱，很丢脸";
    case "steal":
      return "偷了东西，心里七上八下的";

    // 兜底：直接用 description
    default:
      return description;
  }
}

/**
 * 将 tick 转为简短时间标签（如 "06:15"）
 */
export function tickToTimeLabel(tick: number): string {
  const gt = tickToGameTime(tick);
  const hh = String(gt.hour).padStart(2, "0");
  const mm = String(gt.minute).padStart(2, "0");
  return `${hh}:${mm}`;
}
