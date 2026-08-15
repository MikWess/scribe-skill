import { contextBridge, ipcRenderer } from "electron";

const argument = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

contextBridge.exposeInMainWorld("scribeRuntime", {
  api: argument("scribe-api"),
  token: argument("scribe-token"),
  providerKeyStatus: () => ipcRenderer.invoke("scribe:provider-key-status"),
  setProviderKey: (provider: "openai" | "elevenlabs", key: string) =>
    ipcRenderer.invoke("scribe:set-provider-key", provider, key),
  deleteProviderKey: (provider: "openai" | "elevenlabs") =>
    ipcRenderer.invoke("scribe:delete-provider-key", provider),
});
