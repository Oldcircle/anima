/**
 * Character Types — 角色定义
 */

export interface CharacterCard {
  id: string;
  name: string;
  age: number;
  occupation: string;
  home: string;

  personality: {
    traits: string[];
    interests: string[];
    dislikes: string[];
    speechStyle: string;
  };

  background: string;

  dailyRoutine: Record<string, string>;

  relationships: Record<string, { level: number; type: string }>;
}
