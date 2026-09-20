import { readFileSync } from 'node:fs';
export function loadControls(env = process.env) {
  if (!env.GENEALOGY_CONTROLS_PATH) return {};
  const value = JSON.parse(readFileSync(env.GENEALOGY_CONTROLS_PATH, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Controls must be a JSON object');
  return value;
}
export const controls = loadControls();
