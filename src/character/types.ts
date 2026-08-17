/**
 * Character Types — 角色定义
 *
 * 参考 SillyTavern 角色卡深度，Anima 角色卡包含丰富的人格描写。
 * 角色 = 不变的灵魂（Identity）+ 随时间演变的社会身份（Life State）。
 */

/** 可变的生活状态 — 从角色卡初始化，运行时随事件演变 */
export interface LifeState {
  /** 当前职业（可变，如 "面包店学徒" → "面包师"） */
  occupation: string;
  /** 工作地点 ID（如 "bakery"） */
  workplace: string;
  /** 年龄（随游戏年递增） */
  age: number;
  /** 每次 work 的收入（随职业等级变化） */
  income: number;
  /** 技能：通过行为积累，0~10 */
  skills: Record<string, number>;
  /** 长期抱负（从性格定义，极少变化） */
  aspiration: string;
  /** 当前短期目标（从反思中涌现） */
  currentGoal?: string;
  /** 当前担忧（从反思中涌现） */
  currentConcern?: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  /** 性别。注入到 prompt，让其他角色不会认错。值为开放字符串以保留灵活性，
   * 推荐 "female" / "male" / "other"，但也可以写 "女" / "男" / "非二元" 等。 */
  gender?: string;
  /** @deprecated 使用 life.age */
  age: number;
  /** @deprecated 使用 life.occupation */
  occupation: string;
  home: string;

  /** 外貌描写（可选，注入 system prompt） */
  appearance?: string;

  personality: {
    /** 向后兼容：简短标签 */
    traits: string[];
    interests: string[];
    dislikes: string[];
    speechStyle: string;

    /** 深度人格描写（新字段，优先使用） */
    coreTraits?: string;
    psychology?: string;
    stressResponse?: string;
    speech?: {
      style: string;
      habits: string[];
      examples: string[];
    };
  };

  background: string;

  /** 结构化背景经历（新字段，优先使用） */
  backstory?: Array<{ event: string; impact: string }>;

  /** 软偏好：性格化的生活习惯描述，Agent 可遵循可不遵循 */
  preferences?: Record<string, string>;

  /** 生活状态初始值（从 YAML life 段加载） */
  life?: LifeState;

  /** 角色初始携带的物品 ID 列表 */
  startingItems?: string[];

  /**
   * Bartle 玩法人格：achiever|explorer|socializer|killer。
   * 只作用在"先伸手够哪个工具"，不碰台词质地（见 agent/playstyle.ts）。缺省=不注入。
   */
  playstyle?: string;

  relationships: Record<string, {
    level: number;
    type: string;
    /** 关系故事（新字段） */
    context?: string;
  }>;
}
