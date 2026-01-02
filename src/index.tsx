import {
  List,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  Color,
  confirmAlert,
  Alert,
  Form,
  useNavigation,
  LocalStorage,
} from "@raycast/api";
import { useCachedPromise, usePromise } from "@raycast/utils";
import { execSync, exec } from "child_process";
import { useState, useEffect, useCallback } from "react";

const HIDDEN_PORTS_KEY = "hidden-ports";

interface PortInfo {
  port: number;
  pid: number;
  command: string;
  user: string;
  displayName: string;
  projectPath?: string;
  isVite: boolean;
  isDevServer: boolean;
  cwd?: string;
  pageTitle?: string;
}

/** Extract a smart display name from command/path */
function getDisplayName(command: string, cwd?: string): { name: string; project?: string } {
  // macOS .app bundle
  const appMatch = command.match(/\/([^/]+)\.app\//);
  if (appMatch) {
    return { name: appMatch[1] };
  }

  // For cwd, get the last folder name (the actual project folder)
  if (cwd) {
    const folders = cwd.split("/").filter(Boolean);
    const lastFolder = folders[folders.length - 1];
    if (lastFolder && !["node_modules", ".bin", "src", "dist"].includes(lastFolder)) {
      return { name: lastFolder, project: cwd };
    }
  }

  // Node/bun with project path - get the last meaningful folder
  const nodePathMatch = command.match(/(?:node|bun|tsx|ts-node)\s+([^\s]+)/);
  if (nodePathMatch) {
    const parts = nodePathMatch[1].split("/").filter(Boolean);
    // Find the project folder (skip node_modules, .bin, etc)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!["node_modules", ".bin", "src", "dist", "bin"].includes(parts[i]) && !parts[i].endsWith(".js")) {
        return { name: parts[i], project: nodePathMatch[1] };
      }
    }
  }

  // Python script
  const pythonMatch = command.match(/python[3]?\s+(?:.*\/)?([^/\s]+\.py)/);
  if (pythonMatch) {
    return { name: pythonMatch[1] };
  }

  // Just the binary name for system processes
  const binaryMatch = command.match(/^\/[^\s]+\/([^/\s]+)/);
  if (binaryMatch) {
    return { name: binaryMatch[1] };
  }

  // First word as fallback
  const firstWord = command.split(/\s+/)[0];
  return { name: firstWord.split("/").pop() || command.slice(0, 20) };
}

/** Generic titles that aren't useful to display */
const GENERIC_TITLES = [
  "vite",
  "vite app",
  "vite + react",
  "vite + vue",
  "vite + svelte",
  "webpack",
  "next.js",
  "nuxt",
  "localhost",
  "index",
  "home",
  "untitled",
];

/** Try to fetch page title from HTTP server */
async function fetchPageTitle(port: number): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);

    const response = await fetch(`http://localhost:${port}`, {
      signal: controller.signal,
      headers: { Accept: "text/html" },
    });
    clearTimeout(timeout);

    if (!response.ok) return undefined;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return undefined;

    const text = await response.text();
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim().slice(0, 50);

    // Skip generic/useless titles
    if (!title || GENERIC_TITLES.includes(title.toLowerCase())) {
      return undefined;
    }

    return title;
  } catch {
    return undefined;
  }
}

async function getActivePorts(): Promise<PortInfo[]> {
  const output = execSync("/usr/sbin/lsof -iTCP -sTCP:LISTEN -P -n -F pcLn", {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: "/usr/sbin:/usr/bin:/bin:/sbin" },
  });

  if (!output?.trim()) return [];

  const portMap = new Map<string, PortInfo>();
  let currentPid = 0;
  let currentCommand = "";
  let currentUser = "";

  for (const line of output.split("\n")) {
    if (!line) continue;
    const type = line[0];
    const value = line.slice(1);

    switch (type) {
      case "p":
        currentPid = parseInt(value, 10);
        break;
      case "c":
        currentCommand = value;
        break;
      case "L":
        currentUser = value;
        break;
      case "n": {
        const portMatch = value.match(/:(\d+)$/);
        if (!portMatch) break;

        const port = parseInt(portMatch[1], 10);
        // Dedupe by port alone - we only want one entry per port
        const key = String(port);
        if (portMap.has(key)) break;

        let cwd: string | undefined;
        let fullCommand = currentCommand;

        try {
          cwd = execSync(
            `/usr/sbin/lsof -p ${currentPid} -Fn 2>/dev/null | grep "^ncwd" | cut -c5-`,
            { encoding: "utf-8" },
          ).trim() || undefined;

          fullCommand = execSync(`/bin/ps -p ${currentPid} -o args= 2>/dev/null`, {
            encoding: "utf-8",
          }).trim() || currentCommand;
        } catch {
          // ignore
        }

        const isVite = /vite|@vitejs/i.test(fullCommand);
        const isDevServer = isVite || /webpack|next|nuxt|remix|astro/i.test(fullCommand);
        const { name, project } = getDisplayName(fullCommand, cwd);

        portMap.set(key, {
          port,
          pid: currentPid,
          command: fullCommand,
          user: currentUser,
          displayName: name,
          projectPath: project || cwd,
          isVite,
          isDevServer,
          cwd,
        });
        break;
      }
    }
  }

  return Array.from(portMap.values()).sort((a, b) => a.port - b.port);
}

async function killProcess(pid: number, port: number): Promise<boolean> {
  const confirmed = await confirmAlert({
    title: "Kill Process",
    message: `Kill process ${pid} on port ${port}?`,
    primaryAction: { title: "Kill", style: Alert.ActionStyle.Destructive },
  });

  if (!confirmed) return false;

  try {
    execSync(`kill -9 ${pid} 2>/dev/null`);
    await showToast({ style: Toast.Style.Success, title: `Killed process on port ${port}` });
    return true;
  } catch {
    await showToast({ style: Toast.Style.Failure, title: "Failed to kill process" });
    return false;
  }
}

function RestartViteForm({ info, onRestart }: { info: PortInfo; onRestart: () => void }) {
  const { pop } = useNavigation();
  const [newPort, setNewPort] = useState(String(info.port + 1));

  async function handleSubmit() {
    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      await showToast({ style: Toast.Style.Failure, title: "Invalid port number" });
      return;
    }

    try {
      execSync(`kill -9 ${info.pid} 2>/dev/null`);
    } catch {
      // Process may already be dead
    }

    const cwd = info.cwd || process.cwd();
    const toast = await showToast({ style: Toast.Style.Animated, title: "Starting Vite..." });

    exec(`cd "${cwd}" && npm run dev -- --port ${port}`, (error) => {
      if (error) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to start Vite";
      }
    });

    await new Promise((r) => setTimeout(r, 1500));
    toast.style = Toast.Style.Success;
    toast.title = `Vite restarting on port ${port}`;

    onRestart();
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Restart Vite" onSubmit={handleSubmit} icon={Icon.ArrowClockwise} />
        </ActionPanel>
      }
    >
      <Form.Description text={`Restart Vite server from: ${info.cwd || "unknown"}`} />
      <Form.TextField id="port" title="New Port" placeholder="3001" value={newPort} onChange={setNewPort} />
    </Form>
  );
}

async function getHiddenPorts(): Promise<number[]> {
  const stored = await LocalStorage.getItem<string>(HIDDEN_PORTS_KEY);
  return stored ? JSON.parse(stored) : [];
}

async function setHiddenPorts(ports: number[]): Promise<void> {
  await LocalStorage.setItem(HIDDEN_PORTS_KEY, JSON.stringify(ports));
}

function PortListItem({
  info,
  revalidate,
  onHide,
  onUnhide,
  isHiddenView = false,
}: {
  info: PortInfo;
  revalidate: () => void;
  onHide?: (port: number) => void;
  onUnhide?: (port: number) => void;
  isHiddenView?: boolean;
}) {
  const [pageTitle, setPageTitle] = useState<string | undefined>();

  useEffect(() => {
    if (info.isDevServer) {
      fetchPageTitle(info.port).then(setPageTitle);
    }
  }, [info.port, info.isDevServer]);

  const icon = (() => {
    if (info.isVite) return { source: Icon.Bolt, tintColor: Color.Purple };
    if (info.isDevServer) return { source: Icon.Code, tintColor: Color.Green };
    if (info.command.includes("python")) return { source: Icon.Code, tintColor: Color.Yellow };
    if (info.command.includes("docker")) return { source: Icon.Box, tintColor: Color.Blue };
    if (info.command.includes(".app/")) return { source: Icon.AppWindow, tintColor: Color.SecondaryText };
    return { source: Icon.Network, tintColor: Color.SecondaryText };
  })();

  const title = pageTitle || info.displayName;
  const subtitle = info.projectPath
    ? info.projectPath.replace(/^\/Users\/[^/]+\//, "~/").replace(/\/node_modules\/.*/, "")
    : undefined;

  const accessories = [
    { tag: { value: `:${info.port}`, color: info.isDevServer ? Color.Green : Color.SecondaryText } },
  ];
  if (info.isVite) accessories.push({ tag: { value: "Vite", color: Color.Purple } });

  return (
    <List.Item
      key={`${info.port}-${info.pid}`}
      icon={icon}
      title={title}
      subtitle={subtitle}
      accessories={accessories}
      keywords={[String(info.port), info.displayName, info.command]}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Actions">
            <Action.OpenInBrowser
              title="Visit in Browser"
              url={`http://localhost:${info.port}`}
              icon={Icon.Globe}
            />
            <Action
              title="Kill Process"
              icon={Icon.XMarkCircle}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd", "shift"], key: "k" }}
              onAction={async () => {
                if (await killProcess(info.pid, info.port)) revalidate();
              }}
            />
            {info.isVite && info.cwd && (
              <Action.Push
                title="Restart on Different Port"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
                target={<RestartViteForm info={info} onRestart={revalidate} />}
              />
            )}
            {info.cwd && (
              <Action.Open
                title="Open in Terminal"
                target={info.cwd}
                application="com.apple.Terminal"
                icon={Icon.Terminal}
                shortcut={{ modifiers: ["cmd"], key: "t" }}
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Copy">
            <Action.CopyToClipboard
              title="Copy URL"
              content={`http://localhost:${info.port}`}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            <Action.CopyToClipboard title="Copy Port" content={String(info.port)} />
            <Action.CopyToClipboard title="Copy PID" content={String(info.pid)} />
            {info.cwd && <Action.CopyToClipboard title="Copy Path" content={info.cwd} />}
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
              onAction={revalidate}
            />
            {!isHiddenView && onHide && (
              <Action
                title="Hide This Service"
                icon={Icon.EyeDisabled}
                shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                onAction={() => onHide(info.port)}
              />
            )}
            {isHiddenView && onUnhide && (
              <Action
                title="Unhide This Service"
                icon={Icon.Eye}
                shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                onAction={() => onUnhide(info.port)}
              />
            )}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function HiddenServicesView({
  allPorts,
  hiddenPorts,
  onUnhide,
  revalidate,
}: {
  allPorts: PortInfo[];
  hiddenPorts: number[];
  onUnhide: (port: number) => void;
  revalidate: () => void;
}) {
  const hidden = allPorts.filter((p) => hiddenPorts.includes(p.port));

  return (
    <List searchBarPlaceholder="Filter hidden services...">
      {hidden.length === 0 ? (
        <List.EmptyView
          title="No Hidden Services"
          description="Services you hide will appear here"
          icon={Icon.EyeDisabled}
        />
      ) : (
        <List.Section title="Hidden Services" subtitle={`${hidden.length}`}>
          {hidden.map((info) => (
            <PortListItem
              key={`${info.port}-${info.pid}`}
              info={info}
              revalidate={revalidate}
              onUnhide={onUnhide}
              isHiddenView
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

export default function Command() {
  const { isLoading, data: ports, revalidate } = useCachedPromise(getActivePorts, [], {
    keepPreviousData: true,
  });

  const {
    data: hiddenPorts,
    revalidate: revalidateHidden,
    isLoading: isLoadingHidden,
  } = usePromise(getHiddenPorts);

  const hidePort = useCallback(
    async (port: number) => {
      const current = await getHiddenPorts();
      if (!current.includes(port)) {
        await setHiddenPorts([...current, port]);
        await showToast({ style: Toast.Style.Success, title: `Port ${port} hidden` });
        revalidateHidden();
      }
    },
    [revalidateHidden],
  );

  const unhidePort = useCallback(
    async (port: number) => {
      const current = await getHiddenPorts();
      await setHiddenPorts(current.filter((p) => p !== port));
      await showToast({ style: Toast.Style.Success, title: `Port ${port} unhidden` });
      revalidateHidden();
    },
    [revalidateHidden],
  );

  const allPorts = ports || [];
  const visiblePorts = allPorts.filter((p) => !hiddenPorts?.includes(p.port));
  const hiddenCount = allPorts.filter((p) => hiddenPorts?.includes(p.port)).length;

  const devPorts = visiblePorts.filter((p) => p.isDevServer);
  const systemPorts = visiblePorts.filter((p) => !p.isDevServer);

  return (
    <List isLoading={isLoading || isLoadingHidden} searchBarPlaceholder="Filter by port, name, or path...">
      {visiblePorts.length === 0 && !isLoading && (
        <List.EmptyView title="No Active Ports" description="No listening ports found" icon={Icon.Network} />
      )}
      {devPorts.length > 0 && (
        <List.Section title="Development Servers" subtitle={`${devPorts.length}`}>
          {devPorts.map((info) => (
            <PortListItem
              key={`${info.port}-${info.pid}`}
              info={info}
              revalidate={revalidate}
              onHide={hidePort}
            />
          ))}
        </List.Section>
      )}
      {systemPorts.length > 0 && (
        <List.Section title="System & Apps" subtitle={`${systemPorts.length}`}>
          {systemPorts.map((info) => (
            <PortListItem
              key={`${info.port}-${info.pid}`}
              info={info}
              revalidate={revalidate}
              onHide={hidePort}
            />
          ))}
        </List.Section>
      )}
      {hiddenCount > 0 && (
        <List.Section>
          <List.Item
            icon={{ source: Icon.EyeDisabled, tintColor: Color.SecondaryText }}
            title={`${hiddenCount} service${hiddenCount > 1 ? "s" : ""} hidden`}
            accessories={[{ icon: Icon.ChevronRight }]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="View Hidden Services"
                  icon={Icon.Eye}
                  target={
                    <HiddenServicesView
                      allPorts={allPorts}
                      hiddenPorts={hiddenPorts || []}
                      onUnhide={unhidePort}
                      revalidate={revalidate}
                    />
                  }
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}
