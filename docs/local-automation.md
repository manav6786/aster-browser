# Local automation

Start the browser with local control enabled when you want to connect scripts or tools to your tabs.

```sh
npm run start:automation
node bin/aster.cjs tabs.list
node bin/aster.cjs --agent Researcher session
```

In the browser’s Local automation panel, copy the MCP configuration or terminal commands. The session adapter reads one JSON request per line. Supply a `tabId` for existing tab actions. A tab claim keeps other clients from writing to that tab during a multistep task. The human can still change tabs.

The endpoint binds to `127.0.0.1`. The current endpoint and a rotating session token are stored in `~/Library/Application Support/Aster/automation.json` with owner-only permissions. Connected clients can access every tab, including private tabs. Use the interface with trusted local tools. Quit Aster to close the endpoint.
