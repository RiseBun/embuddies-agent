const host = window.EMBUDDIES_DESKTOP;

if (host) {
  document.documentElement.classList.add("electronHost");
  window.NL_TOKEN = "electron";
  window.NL_PORT = 1;
  window.NL_OS = "Windows";
  window.NL_ARGS = host.args;

  const listeners = new Map();
  function emit(name, detail) {
    for (const listener of listeners.get(name) || []) listener({ detail });
  }
  const invoke = (name, ...args) => host.invoke(name, args);
  host.onEvent(emit);

  window.Neutralino = {
    init: () => window.setTimeout(() => emit("ready"), 0),
    app: { exit: () => invoke("app.exit") },
    events: {
      on(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
        return Promise.resolve();
      },
      broadcast: (name, detail) => invoke("events.broadcast", name, detail),
    },
    clipboard: { writeText: (value) => invoke("clipboard.writeText", value) },
    computer: {
      getDisplays: () => invoke("computer.getDisplays"),
      getMousePosition: () => invoke("computer.getMousePosition"),
    },
    os: {
      execCommand: (command) => invoke("os.execCommand", command),
      getSpawnedProcesses: () => invoke("os.getSpawnedProcesses"),
      setTray: (options) => invoke("os.setTray", options),
      showFolderDialog: (title) => invoke("os.showFolderDialog", title),
    },
    window: {
      beginDrag: (x, y) => invoke("window.beginDrag", x, y),
      create: (url, options) => invoke("window.create", url, options),
      getPosition: () => invoke("window.getPosition"),
      getSize: () => invoke("window.getSize"),
      hide: () => invoke("window.hide"),
      isMaximized: () => invoke("window.isMaximized"),
      maximize: () => invoke("window.maximize"),
      move: (x, y) => invoke("window.move", x, y),
      setAlwaysOnTop: (value) => invoke("window.setAlwaysOnTop", value),
      setSize: (size) => invoke("window.setSize", size),
      show: () => invoke("window.show"),
      unmaximize: () => invoke("window.unmaximize"),
    },
  };
}
