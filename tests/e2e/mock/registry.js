function scenarioKey(entry) {
  if (entry.command) return entry.command;
  if (entry.commands) return entry.commands.join(', ');
  if (entry.prefix) return `${entry.prefix}*`;
  return null;
}

function validateScenario(entry) {
  const hasCommand = typeof entry.command === 'string' && entry.command.length > 0;
  const hasCommands = Array.isArray(entry.commands) && entry.commands.length > 0;
  const hasPrefix = typeof entry.prefix === 'string' && entry.prefix.length > 0;

  if ([hasCommand, hasCommands, hasPrefix].filter(Boolean).length !== 1) {
    throw new Error('Visual mock scenario must define exactly one of command, commands, or prefix');
  }
  if (hasCommands && entry.commands.some(command => typeof command !== 'string' || command.length === 0)) {
    throw new Error('Visual mock scenario commands must be non-empty strings');
  }
  if (typeof entry.run !== 'function') {
    throw new Error(`Visual mock scenario ${scenarioKey(entry) || '(unknown)'} must define run()`);
  }
}

export function createVisualMockScenarioRegistry(entries = []) {
  const exactScenarios = new Map();
  const prefixScenarios = [];
  const orderedKeys = [];

  for (const entry of entries) {
    validateScenario(entry);
    const key = scenarioKey(entry);

    if (exactScenarios.has(key) || prefixScenarios.some(item => scenarioKey(item) === key)) {
      throw new Error(`Duplicate visual mock scenario key: ${key}`);
    }

    if (entry.commands) {
      for (const command of entry.commands) {
        if (exactScenarios.has(command)) {
          throw new Error(`Duplicate visual mock scenario key: ${command}`);
        }
        orderedKeys.push(command);
        exactScenarios.set(command, entry);
      }
    } else {
      orderedKeys.push(key);
      if (entry.command) exactScenarios.set(entry.command, entry);
      else prefixScenarios.push(entry);
    }
  }

  function find(command) {
    if (exactScenarios.has(command)) return exactScenarios.get(command);
    return prefixScenarios.find(entry => command.startsWith(entry.prefix)) || null;
  }

  return {
    commands() {
      return [...orderedKeys];
    },
    async run(command, context = {}) {
      const scenario = find(command);
      if (!scenario) return false;
      try {
        await scenario.run({ ...context, cmd: command });
      } catch (err) {
        // 场景自己的 bug 只该让触发它的那条用例失败（验收 O71）。调用方 user:message 是 async 处理函数，
        // 拒绝没人接，Node 会直接退出 mock 进程，同一分片里排在后面的用例全部变成「未连接」假红。
        // 响亮地记下来、不往外抛：触发它的那条用例照样等不到该来的事件而失败，栈在 webServer 日志里。
        console.error(`[mock] 场景 ${command} 抛错（已隔离，触发它的用例应会失败）：`, err);
      }
      return true;
    },
  };
}
