// Desktop/CLI integration flags belong to the calling product. A native worker
// receives OS and network settings only, plus explicitly supplied embuddies values.
const inherited = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATHEXT",
  "PSMODULEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "LANG",
  "LC_ALL",
]);

export function nativeProcessEnvironment(home, apiKey, extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      inherited.has(key.toUpperCase()),
    ),
  );
  return {
    ...env,
    ...extra,
    CODEX_HOME: home,
    EMBUDDIES_RUNTIME_HOME: home,
    EMBUDDIES_MODEL_API_KEY: apiKey,
  };
}
