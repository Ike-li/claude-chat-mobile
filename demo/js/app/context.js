// Shared application boundary for browser modules. Modules receive this object
// explicitly instead of reaching through new globals.
export function createAppContext({ dom = {}, state = {}, dependencies = {} } = {}) {
  return {
    dom,
    state,
    dependencies,
    socket: null,
    setSocket(socket) {
      this.socket = socket;
      return socket;
    },
  };
}
