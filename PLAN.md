# Service-Specific Features Plan

## Overview

Extend Active Ports with custom actions for detected service types.

## 1. FastAPI/Uvicorn

**Detection**: Command contains `uvicorn` or `fastapi`

**Actions**:
- Open API Docs (`/docs`) - Swagger UI
- Open ReDoc (`/redoc`) - Alternative docs
- Restart with `--reload` flag
- Restart on different port

**Implementation**:
- Add `isFastAPI` boolean to PortInfo
- Add detection in `getActivePorts()`
- Add actions in PortListItem
- Create `RestartUvicornForm` component

---

## 2. Docker Compose

**Detection**: Command contains `docker` or check if port is from a container via `docker ps`

**Actions**:
- Restart container (`docker restart <container>`)
- View logs (`docker logs -f <container>`) - opens Terminal
- Stop container (`docker stop <container>`)
- Open shell (`docker exec -it <container> sh`)

**Implementation**:
- Add `dockerContainer?: string` to PortInfo
- Query `docker ps --format` to map ports to container names
- Add Docker-specific actions when container is detected

---

## 3. Next.js

**Detection**: Command contains `next` or `next-server`

**Actions**:
- Restart on different port
- Open in browser (already exists)
- Clear `.next` cache and restart

**Implementation**:
- Add `isNextJS` boolean to PortInfo
- Add detection alongside existing dev server detection
- Create `RestartNextForm` component (similar to Vite)

---

## 4. Flask

**Detection**: Command contains `flask` or `FLASK_APP`

**Actions**:
- Restart with debug mode (`--debug`)
- Restart on different port (`--port`)
- Open in browser

**Implementation**:
- Add `isFlask` boolean to PortInfo
- Create `RestartFlaskForm` component
- Detect Flask dev server pattern

---

## 5. SvelteKit Preview

**Detection**: Already detected as Vite, check for `svelte` in command or cwd package.json

**Actions**:
- Run preview mode (`npm run preview`)
- Restart dev on different port (existing)

**Implementation**:
- Add `isSvelteKit` boolean to PortInfo
- Check package.json in cwd for svelte dependencies
- Add "Run Preview" action that builds and previews

---

## Architecture Changes

### PortInfo Interface
```typescript
interface PortInfo {
  // existing fields...

  // Service detection flags
  isVite: boolean;
  isDevServer: boolean;
  isFastAPI: boolean;
  isFlask: boolean;
  isNextJS: boolean;
  isSvelteKit: boolean;

  // Docker info
  dockerContainer?: string;
  dockerImage?: string;
}
```

### Service Detection Function
```typescript
function detectServiceType(command: string, cwd?: string): ServiceFlags {
  return {
    isVite: /vite|@vitejs/i.test(command),
    isFastAPI: /uvicorn|fastapi/i.test(command),
    isFlask: /flask/i.test(command),
    isNextJS: /next-server|next dev/i.test(command),
    isSvelteKit: /svelte/i.test(command), // + check package.json
  };
}
```

### Docker Port Mapping
```typescript
async function getDockerPorts(): Promise<Map<number, DockerInfo>> {
  // Run: docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Image}}'
  // Parse port mappings like "0.0.0.0:3000->3000/tcp"
  // Return map of host port -> container info
}
```

## Implementation Order

1. **Refactor**: Extract service detection into separate function
2. **FastAPI**: Most used Python framework in your projects
3. **Docker**: Cross-cutting, affects many services
4. **Next.js**: Similar to existing Vite support
5. **Flask**: Similar to FastAPI
6. **SvelteKit**: Enhancement to existing Vite detection

## UI Considerations

- Group actions by category in ActionPanel
- Use appropriate icons for each service type
- Show service type as colored tag (like Vite currently)
- Keep menu bar simple, full actions in main view only
