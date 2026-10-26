import json
import subprocess
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE = REPO_ROOT / "tools" / "electron-runtime-debug" / "index.cjs"
BRIDGE_README = REPO_ROOT / "tools" / "electron-runtime-debug" / "README.md"
BRIDGE_EXAMPLE = REPO_ROOT / "tools" / "electron-runtime-debug" / "example-main.cjs"
BRIDGE_HARNESS = REPO_ROOT / "tools" / "electron-runtime-debug" / "test-harness.cjs"


class ElectronRuntimeDebugBridgeTest(unittest.TestCase):
    def node(self, source):
        completed = subprocess.run(
            ["node", "-e", source],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr or completed.stdout)
        return completed.stdout

    def test_bridge_is_loopback_by_default_and_documents_isolated_contexts(self):
        source = BRIDGE.read_text(encoding="utf-8")
        readme = BRIDGE_README.read_text(encoding="utf-8")
        self.assertIn("DEFAULT_HOST = '127.0.0.1'", source)
        self.assertIn("allowNonLoopback", source)
        self.assertIn("Runtime.executionContextCreated", source)
        self.assertIn("Debugger.scriptParsed", source)
        self.assertIn("webContents.debugger", source)
        self.assertIn("MAX_WS_MESSAGE_BYTES", source)
        self.assertIn("if (server && server.listening) server.close()", source)
        self.assertIn("Electron Isolated Context", readme)
        self.assertIn("chrome://inspect/#devices", readme)
        self.assertIn("loopback", readme.lower())

    def test_loopback_guard_and_protocol_url(self):
        source = textwrap.dedent(
            f"""
            'use strict';
            const bridge = require({json.dumps(str(BRIDGE))});
            if (!bridge.isLoopbackHost('127.0.0.1') || !bridge.isLoopbackHost('::1')) {{
              throw new Error('loopback detection failed');
            }}
            if (bridge.isLoopbackHost('0.0.0.0') || bridge.isLoopbackHost('192.168.1.2')) {{
              throw new Error('non-loopback host was accepted');
            }}
            if (bridge.protocolUrl('127.0.0.1', 9222) !== 'http://127.0.0.1:9222') {{
              throw new Error('IPv4 protocol URL mismatch');
            }}
            if (bridge.protocolUrl('::1', 9222) !== 'http://[::1]:9222') {{
              throw new Error('IPv6 protocol URL mismatch');
            }}
            """
        )
        self.node(source)

    def test_installer_refuses_nonloopback_without_explicit_opt_in(self):
        source = textwrap.dedent(
            f"""
            'use strict';
            const {{ EventEmitter }} = require('node:events');
            const bridge = require({json.dumps(str(BRIDGE))});
            const app = new EventEmitter();
            let rejected = false;
            try {{
              bridge.installElectronRuntimeDebug({{
                electron: {{ app, shell: {{}} }},
                host: '0.0.0.0',
                port: 0
              }});
            }} catch (error) {{
              rejected = /non-loopback/.test(error.message);
            }}
            if (!rejected) throw new Error('non-loopback bridge was not rejected');
            """
        )
        self.node(source)

    def test_websocket_parser_decodes_masked_text_and_rejects_unmasked_client_frames(self):
        source = textwrap.dedent(
            f"""
            'use strict';
            const bridge = require({json.dumps(str(BRIDGE))});
            const received = [];
            let error = null;
            const parser = bridge.createClientWebSocketParser({{
              onText: text => received.push(text),
              onError: value => {{ error = value; }}
            }});
            const payload = Buffer.from(JSON.stringify({{ id: 7, method: 'Runtime.enable' }}));
            const mask = Buffer.from([1, 2, 3, 4]);
            const masked = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
            parser.push(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
            if (received.length !== 1 || JSON.parse(received[0]).method !== 'Runtime.enable') {{
              throw new Error('masked client text frame was not decoded');
            }}
            parser.push(Buffer.from([0x81, 2, 123, 125]));
            if (!error || !/masked/.test(error.message)) {{
              throw new Error('unmasked frame was not rejected');
            }}
            """
        )
        self.node(source)

    def test_target_shapes_use_cdp_target_info_and_standard_target_description(self):
        source = textwrap.dedent(
            f"""
            'use strict';
            const bridge = require({json.dumps(str(BRIDGE))});
            const tracker = {{
              id: 'electron-4',
              window: {{ getTitle: () => 'Renderer' }},
              contents: {{ getURL: () => 'app://example/index.html' }}
            }};
            const description = bridge.makeTargetDescription(tracker, '127.0.0.1', 9222);
            const info = bridge.makeTargetInfo(tracker);
            if (description.id !== 'electron-4' || !description.webSocketDebuggerUrl.endsWith('/electron-4')) {{
              throw new Error('target description does not expose a websocket endpoint');
            }}
            if (info.targetId !== 'electron-4' || info.id !== undefined || info.type !== 'page') {{
              throw new Error('Target domain response shape is invalid');
            }}
            """
        )
        self.node(source)

    def test_example_installs_before_browserwindow_creation(self):
        source = BRIDGE_EXAMPLE.read_text(encoding="utf-8")
        self.assertLess(source.index("installElectronRuntimeDebug"), source.index("new BrowserWindow"))
        self.assertIn("host: '127.0.0.1'", source)
        self.assertIn("shortcut: 'F12'", source)

    def test_fake_electron_harness_replays_isolated_context_over_cdp(self):
        completed = subprocess.run(
            ["node", str(BRIDGE_HARNESS)],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr or completed.stdout)
        result = json.loads(completed.stdout)
        self.assertTrue(result["replayedIsolatedContext"])
        self.assertGreaterEqual(result["records"], 2)


if __name__ == "__main__":
    unittest.main()
