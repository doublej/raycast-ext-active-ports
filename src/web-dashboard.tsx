import { environment, getPreferenceValues, open, showHUD } from "@raycast/api";
import { spawn } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { join } from "path";

const SERVER_FILE = "port-server.mjs";

async function isRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export default async function Command() {
  const { port: portPref } = getPreferenceValues<{ port: string }>();
  const port = parseInt(portPref || "47823", 10) || 47823;
  const url = `http://localhost:${port}`;

  if (await isRunning(port)) {
    await open(url);
    await showHUD("Opened Active Ports dashboard");
    return;
  }

  // Copy the server into the writable support dir; it stores its config there.
  const src = join(environment.assetsPath, SERVER_FILE);
  const dest = join(environment.supportPath, SERVER_FILE);
  if (!existsSync(src)) {
    await showHUD("Server file missing — rebuild the extension");
    return;
  }
  copyFileSync(src, dest);

  // process.execPath is Raycast's bundled Node binary — always present.
  const child = spawn(process.execPath, [dest, environment.supportPath, String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Give the server a moment to bind before opening the browser.
  for (let i = 0; i < 20; i++) {
    if (await isRunning(port)) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  await open(url);
  await showHUD(`Active Ports dashboard running on :${port}`);
}
