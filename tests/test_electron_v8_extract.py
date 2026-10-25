import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = REPO_ROOT / "tools" / "electron_v8_extract.cjs"
RENDER_MAIN = REPO_ROOT / "tools" / "electron_renderer_verify_main.cjs"
RENDER_PRELOAD = REPO_ROOT / "tools" / "electron_renderer_verify_preload.cjs"
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
        self.assertIn("discoverReturnedFunctions", source)
        self.assertIn("skipped-async", source)
        self.assertIn("node:fs/promises", source)
        # Class methods and accessors are usually non-enumerable.  The
        # extractor must walk descriptors rather than only enumerable exports.
        self.assertIn("Reflect.ownKeys", source)
        self.assertIn("MAX_EXPORTED_GRAPH_DEPTH", source)

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


if __name__ == "__main__":
    unittest.main()
