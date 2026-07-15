export function createSessionWorkspaceState(context) {
  const sessionDomCache = new Map();
  const sessionDraftCache = new Map();
  const seenDiskLenBySession = new Map();
  const sessionsCache = new Map();
  const state = {
    sessionDomCache,
    sessionDraftCache,
    sessionDrafts: sessionDraftCache,
    seenDiskLenBySession,
    sessionsCache,
  };
  context.state.sessionWorkspaces = state;
  return state;
}
