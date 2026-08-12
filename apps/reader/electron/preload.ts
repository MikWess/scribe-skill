import { contextBridge } from "electron";

const argument = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

contextBridge.exposeInMainWorld("scribeRuntime", {
  api: argument("scribe-api"),
  token: argument("scribe-token"),
});
