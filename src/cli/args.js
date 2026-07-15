const REPEATABLE = new Set(['allowed-path', 'criterion', 'arg', 'failure', 'rule', 'skill', 'default-skill']);
const BOOLEAN = new Set(['json', 'mine', 'no-save', 'help', 'version', 'once']);

export function parseCliArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalAt = token.indexOf('=');
    const rawName = token.slice(2, equalAt === -1 ? undefined : equalAt);
    if (!rawName) throw new Error('Empty option name.');
    const name = rawName.replaceAll('_', '-');
    let value;
    if (equalAt !== -1) {
      value = token.slice(equalAt + 1);
    } else if (BOOLEAN.has(name)) {
      value = true;
    } else if (argv[index + 1] != null && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = true;
    }

    if (REPEATABLE.has(name)) {
      options[name] = [...(options[name] ?? []), value];
    } else {
      options[name] = value;
    }
  }

  return { positionals, options };
}

export function option(options, name, fallback = undefined) {
  const value = options[name];
  return value === undefined ? fallback : value;
}

export function requireOption(options, name, message = `--${name} is required.`) {
  const value = option(options, name);
  if (value === undefined || value === true || String(value).trim() === '') throw new Error(message);
  return String(value);
}

export function listOption(options, name) {
  const value = options[name];
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
}

export function repeatedOption(options, name) {
  const value = options[name];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}
