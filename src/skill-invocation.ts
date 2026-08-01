const LEADING_SKILL = /^([\t ]*)\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?=\s|$)/u;

export function leadingSkillName(prompt: string): string | null {
  return LEADING_SKILL.exec(prompt)?.[2] ?? null;
}

export function replaceLeadingSkill(prompt: string, replacementName: string, prefix: "$" | "/"): string {
  return prompt.replace(LEADING_SKILL, (_match, leading: string) => `${leading}${prefix}${replacementName}`);
}

export function leadingSkillArguments(prompt: string): string {
  return prompt.replace(LEADING_SKILL, "").trim();
}
