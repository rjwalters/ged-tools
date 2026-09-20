#!/usr/bin/env node
import { resolve } from 'node:path';
const commands = new Set([
  'browser-lock', 'fs-catalog', 'fs-film', 'fs-fulltext', 'fs-personas',
  'fs-image', 'fs-books', 'fs-audit', 'prdh-couples', 'prdh-familles',
  'prdh-search', 'prdh-record', 'archion', 'matricula', 'gro-search',
  'freebmd', 'register-cache', 'register-seek', 'register-batch',
]);
const args = process.argv.slice(2);
if (args[0] === '--project') {
  if (!args[1] || args[1].startsWith('-')) throw new Error('--project requires a directory');
  process.env.GENEALOGY_PROJECT_ROOT = resolve(args[1]);
  args.splice(0, 2);
}
const command = args.shift();
if (!command || ['--help', '-h', 'help'].includes(command)) {
  console.log('Usage: ged-tools [--project DIRECTORY] COMMAND [arguments]\n\n' + [...commands].join('\n'));
} else if (!commands.has(command)) {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
} else {
  try {
    // Legacy parsers use process.argv; normalize it along with explicit arguments.
    process.argv = [process.execPath, process.argv[1], ...args];
    const module = await import(`../src/scripts/${command}.js`);
    if (args.includes('--help') || args.includes('-h')) {
      if (module.usage) module.usage();
      else console.log(`ged-tools ${command}: see README.md for arguments and configuration.`);
    } else {
      const code = await module.main(args);
      if (Number.isInteger(code)) process.exitCode = code;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
