import unittest
import json
import subprocess
import textwrap
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = REPO_ROOT / "tools" / "electron_v8_extract.cjs"
RENDER_MAIN = REPO_ROOT / "tools" / "electron_renderer_verify_main.cjs"
RENDER_PRELOAD = REPO_ROOT / "tools" / "electron_renderer_verify_preload.cjs"
RENDER_EXTRACT_MAIN = REPO_ROOT / "tools" / "electron_renderer_extract_main.cjs"
RENDER_EXTRACT_PRELOAD = REPO_ROOT / "tools" / "electron_renderer_extract_preload.cjs"
INSPECTOR_LOCALS = REPO_ROOT / "tools" / "electron_v8_inspector_locals.cjs"


class ElectronV8ExtractorContractTest(unittest.TestCase):
    def test_extractor_has_safe_mode_boundaries(self):
        source = EXTRACTOR.read_text(encoding="utf-8")
        self.assertIn("'verify', 'root', 'module', 'discover'", source)
        self.assertIn("'trace', 'none'", source)
        self.assertIn("CommonJS wrapper body is not called", source)
        self.assertIn("cachedDataRejected", source)
        self.assertIn("createInertValue", source)
        self.assertIn("'browser'", source)
        self.assertIn("electron_renderer_verify", source)
        self.assertIn("%GetBytecode", source)
        self.assertIn("%DebugPrint", source)
        self.assertIn("createReadOnlyFs", source)
        self.assertIn("createKoffiStub", source)
        self.assertIn("captureEventHandler", source)
        self.assertIn("electron.app", source)
        self.assertIn("discoverReturnedFunctions", source)
        self.assertIn("skipped-async", source)
        self.assertIn("node:fs/promises", source)
        # Class methods and accessors are usually non-enumerable.  The
        # extractor must walk descriptors rather than only enumerable exports.
        self.assertIn("Reflect.ownKeys", source)
        self.assertIn("MAX_EXPORTED_GRAPH_DEPTH", source)
        self.assertIn("--trace-file FILE", source)
        self.assertIn("createTraceSink", source)
        self.assertIn("fputs", source)
        self.assertIn("freopen", source)

    def test_export_graph_recovers_non_enumerable_class_and_accessor_logic(self):
        source = EXTRACTOR.read_text(encoding="utf-8")
        start = source.index("function collectFunctions(")
        end = source.index("function safeKey(", start)
        collector = source[start:end]

        # `Object.keys` would skip class prototype methods and accessors.  The
        # recovery graph must use descriptors without invoking target getters.
        self.assertIn("Reflect.ownKeys(value)", collector)
        self.assertIn("Object.getOwnPropertyDescriptor(value, key)", collector)
        self.assertIn("descriptor.get", collector)
        self.assertIn("descriptor.set", collector)
        self.assertIn("key === 'arguments'", collector)
        self.assertNotIn("Object.keys(value)", collector)

    def test_discover_recovers_installer_methods_written_to_inert_arguments(self):
        # A common plugin pattern is `install(Engine)`, followed by writes to
        # `Engine.prototype`. The installer returns nothing, so ordinary return
        # value discovery cannot reach its closures. Exercise the generic inert
        # argument capture path with both assignment and defineProperty.
        program = textwrap.dedent(
            f"""
            'use strict';
            const vm = require('node:vm');
            const extractor = require({json.dumps(str(EXTRACTOR))});
            const observations = {{ stubCalls: [], stubWrites: [] }};
            const context = vm.createContext({{}});
            function install(Type) {{
              Type.prototype.directInstalled = function directInstalled() {{ return 1; }};
              Object.defineProperty(Type.prototype, 'descriptorInstalled', {{
                value: function descriptorInstalled() {{ return 2; }}
              }});
            }}
            const result = extractor.discoverReturnedFunctions(
              context,
              [{{ label: 'exports.install', fn: install }}],
              1000,
              observations
            );
            const labels = result.functions.map(entry => entry.label).sort();
            if (!labels.includes('exports.install(argument0).directInstalled')) {{
              throw new Error('missing assignment-installed closure: ' + labels.join(', '));
            }}
            if (!labels.includes('exports.install(argument0).descriptorInstalled')) {{
              throw new Error('missing descriptor-installed closure: ' + labels.join(', '));
            }}
            if (!observations.stubWrites.some(item => item.endsWith('.directInstalled'))) {{
              throw new Error('assignment write was not observed');
            }}
            if (!observations.stubWrites.some(item => item.endsWith('.descriptorInstalled<defineProperty>'))) {{
              throw new Error('descriptor write was not observed');
            }}
            """
        )
        completed = subprocess.run(
            ["node", "--allow-natives-syntax", "-e", program],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr or completed.stdout)

    def test_electron_app_stub_is_extensible_without_executing_host_methods(self):
        source = EXTRACTOR.read_text(encoding="utf-8")
        start = source.index("function createElectronStub(")
        end = source.index("function createSandbox(", start)
        app_stub = source[start:end]

        # New Electron releases add app APIs frequently.  Unknown methods must
        # stay inert, while event handlers remain recoverable bytecode roots.
        self.assertIn("new Proxy(appTarget", app_stub)
        self.assertIn("return appTarget[property]", app_stub)
        self.assertIn("callbacks.push", app_stub)
        self.assertIn("createInertCallbackChain", app_stub)
        self.assertIn("whenReady') return () => readyChain", app_stub)
        self.assertIn("electron.app.commandLine", app_stub)
        self.assertNotIn("require('electron')", app_stub)

    def test_renderer_verifier_does_not_invoke_the_wrapper(self):
        source = RENDER_PRELOAD.read_text(encoding="utf-8")
        self.assertIn("wrapper is\n// not invoked", source)
        self.assertIn("script.runInThisContext()", source)
        self.assertNotIn("wrapper(", source)

    def test_renderer_host_uses_a_hidden_window_and_reports_via_ipc(self):
        source = RENDER_MAIN.read_text(encoding="utf-8")
        self.assertIn("show: false", source)
        self.assertIn("jsc2js-renderer-verify-result", source)
        self.assertIn("preload: path.join(__dirname", source)

    def test_renderer_root_extractor_never_invokes_the_wrapper(self):
        main = RENDER_EXTRACT_MAIN.read_text(encoding="utf-8")
        preload = RENDER_EXTRACT_PRELOAD.read_text(encoding="utf-8")
        self.assertIn("show: false", main)
        self.assertIn("jsc2js-renderer-extract-result", main)
        self.assertIn("--allow-natives-syntax --print-bytecode", main)
        self.assertIn("%GetBytecode(wrapper)", preload)
        self.assertIn("%DebugPrint", preload)
        self.assertIn("bytecodeInfoKeys", preload)
        self.assertIn("new Uint8Array(info.bytecode)", preload)
        self.assertIn("script.runInThisContext()", preload)
        self.assertNotIn("wrapper(", preload)

    def test_inspector_local_enumerator_uses_only_the_isolated_extractor(self):
        source = INSPECTOR_LOCALS.read_text(encoding="utf-8")
        # The local-closure collector traverses Inspector [[Scopes]] rather than
        # querying every object in the isolate.  That keeps it bounded to the
        # JSC module currently being recovered.
        self.assertIn("[[Scopes]]", source)
        self.assertIn("collectClosureScopeFunctions", source)
        self.assertIn("materializeZeroArgumentExports", source)
        self.assertIn("moduleInitialization = 'interrupted'", source)
        self.assertIn("runModuleWrapper(context", source)
        self.assertIn("collectTargetOwnProperties", source)
        self.assertIn("seenObjects", source)
        self.assertIn("__jsc2js_inspector_callbacks", source)
        self.assertIn("initialized.callbacks", source)
        self.assertIn("${path.basename(absolute)}:${item.label}", source)


if __name__ == "__main__":
    unittest.main()
