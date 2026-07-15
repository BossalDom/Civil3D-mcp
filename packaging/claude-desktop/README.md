# Civil 3D MCP for Claude Desktop

This extension starts the Civil 3D MCP Node.js server automatically when Claude
Desktop enables it. It is self-contained and does not run `npm install` on the
user's machine.

## Required Civil 3D setup

The extension installs the Claude-side MCP server. Autodesk Civil 3D 2026 must
be open with `Civil3DMcpPlugin.dll` loaded separately:

1. Build or download the native plugin.
2. In Civil 3D, run `NETLOAD` and select `Civil3DMcpPlugin.dll`.
3. Add the DLL to the `APPLOAD` Startup Suite if it should load automatically.
4. Keep the default plugin port at `8080`, or enter the configured port while
   installing the extension.

The Node.js server also starts its loopback HTTP bridge on port `3000` by
default. If another process already owns that port, choose a different HTTP
bridge port in the extension settings.

## Local Autodesk help

The extension auto-discovers Autodesk Civil 3D Offline Help under Program Files.
The `civil3d_help` tool searches those local files and can return the matching
screenshots, diagrams, and Autodesk tutorial videos with each topic. Video-aware
clients receive a player and all clients receive a direct MP4 fallback. Topic and
image search works even when Civil 3D is not open or the machine is offline;
video playback requires internet access. If help is stored elsewhere, set the
optional **Civil 3D offline help folder** setting to its `Help` directory.

## Claude Desktop installation

1. Open **Claude Desktop > Settings > Extensions**.
2. Open **Advanced settings** and select **Install Extension**.
3. Select the versioned `.mcpb` file.
4. Accept the default connection settings for a standard local installation.
5. Start Civil 3D, load the native plugin, and ask Claude to run
   `civil3d_health`.

The `.dxt` file produced beside the `.mcpb` is a byte-for-byte legacy
compatibility copy for older Claude Desktop releases. Current releases use the
`.mcpb` filename.

Source, native plugin build instructions, and troubleshooting:
https://github.com/Sacred-G/Civil3D-mcp
