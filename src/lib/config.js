import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
export const CONFIG_FILENAME = 'genealogy.config.json';

export const CONFIG_KEYS = {
  gedPath: ['data/tree.ged', 'GENEALOGY_GED_PATH'],
  recordsDir: ['records', 'GENEALOGY_RECORDS_DIR'],
  worklistPath: ['records/consistency/worklist.json', 'GENEALOGY_WORKLIST_PATH'],
};

export function resolveConfig(root, fileConfig = null, env = {}) {
  if (fileConfig !== null) {
    if (typeof fileConfig !== 'object' || Array.isArray(fileConfig)) {
      throw new Error(`${CONFIG_FILENAME}: expected a JSON object at the top level`);
    }
    const unknown = Object.keys(fileConfig).filter((k) => !(k in CONFIG_KEYS));
    if (unknown.length) {
      throw new Error(
        `${CONFIG_FILENAME}: unknown key(s) ${unknown.join(', ')} — ` +
          `valid keys are ${Object.keys(CONFIG_KEYS).join(', ')}`
      );
    }
  }
  const out = {};
  for (const [key, [dflt, envVar]] of Object.entries(CONFIG_KEYS)) {
    let value = dflt;
    if (fileConfig !== null && key in fileConfig) {
      if (typeof fileConfig[key] !== 'string' || fileConfig[key] === '') {
        throw new Error(`${CONFIG_FILENAME}: ${key} must be a non-empty string`);
      }
      value = fileConfig[key];
    }
    if (env[envVar]) value = env[envVar];
    out[key] = isAbsolute(value) ? value : resolve(root, value);
  }
  return out;
}

export function loadConfig(root, env = process.env) {
  const file = join(root, CONFIG_FILENAME);
  let fileConfig = null;
  let raw = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (raw !== null) {
    try {
      fileConfig = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file}: invalid JSON (${err.message})`);
    }
  }
  return resolveConfig(root, fileConfig, env);
}
