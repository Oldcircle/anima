/**
 * Character Types — 角色定义
 *
 * 参考 SillyTavern 角色卡深度，Anima 角色卡包含丰富的人格描写。
 */

export interface CharacterCard {
  id: string;
  name: string;
  age: number;
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

  relationships: Record<string, {
    level: number;
    type: string;
    /** 关系故事（新字段） */
    context?: string;
  }>;
}
