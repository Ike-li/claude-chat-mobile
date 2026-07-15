export function createInstanceManager() {
  let counter = 0;
  const agents = new Map();
  const permissionModes = new Map();
  const efforts = new Map();
  const done = new Set();
  const errors = new Set();
  const aborted = new Set();

  const nextId = () => `inst_${++counter}`;
  const permissionModeOf = id => permissionModes.get(id) ?? 'default';
  const effortOf = id => efforts.get(id) ?? null;

  function forSession(sessionId) {
    if (!sessionId) return null;
    for (const agent of agents.values()) {
      if (agent.sessionId === sessionId) return agent;
    }
    return null;
  }

  function inheritedMode(cwd) {
    let mode = 'default';
    for (const agent of agents.values()) {
      if (agent.cwd === cwd) mode = agent.permissionMode;
    }
    return mode;
  }

  function inheritedEffort(cwd) {
    let effort = null;
    for (const agent of agents.values()) {
      if (agent.cwd === cwd) effort = agent.effort;
    }
    return effort;
  }

  function stateOf(id) {
    const agent = agents.get(id);
    if (!agent) return 'idle';
    if (agent.pendingPermissions.size > 0 || agent.pendingQuestions.size > 0) return 'permission';
    if (agent.pendingTurns > 0 || agent.hasBgTasks?.()) return 'busy';
    if (aborted.has(id)) return 'aborted';
    if (errors.has(id)) return 'error';
    if (done.has(id)) return 'done';
    return 'idle';
  }

  function remove(id) {
    const agent = agents.get(id);
    if (!agent) return null;
    agent.dispose();
    agents.delete(id);
    permissionModes.delete(id);
    efforts.delete(id);
    done.delete(id);
    errors.delete(id);
    aborted.delete(id);
    return agent;
  }

  return {
    agents,
    permissionModes,
    efforts,
    done,
    errors,
    aborted,
    nextId,
    permissionModeOf,
    effortOf,
    forSession,
    inheritedMode,
    inheritedEffort,
    stateOf,
    remove,
  };
}
