# Active Ports

View and manage listening ports on your Mac from Raycast.

## Features

- List all TCP ports with process info
- Service detection: Vite, FastAPI, Flask, Next.js, SvelteKit, Docker
- Service-specific actions (open Swagger docs, restart on different port, etc.)
- Kill processes, open in browser, copy URLs
- Hide/unhide ports you don't care about
- Menu bar widget showing active port count

## Usage

Open Raycast and search "Show Active Ports" or use the menu bar widget.

### Actions

| Service | Actions |
|---------|---------|
| FastAPI | Open /docs, Open /redoc, Restart with --reload |
| Docker | Restart/stop container, view logs, open shell |
| Vite | Restart on different port |
| Next.js | Restart on different port |
| Flask | Restart with --debug |
| SvelteKit | Build and run preview |

## Installation

```bash
git clone https://github.com/doublej/active-ports
cd active-ports
npm install
npm run dev
```

## License

MIT
