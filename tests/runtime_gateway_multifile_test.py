import tempfile
import unittest
from pathlib import Path

from devflow_runtime.bridge import DevflowSession


class MultiFileBridgeTest(unittest.TestCase):
    def test_propose_files_applies_bounded_web_files(self):
        with tempfile.TemporaryDirectory() as root:
            with DevflowSession(
                workspace_root=root,
                requirements=["add a bounded read-only web dashboard"],
                acceptances=[
                    {"id": "diff", "verifier_ref": "diff", "required": True},
                    {"id": "scope", "verifier_ref": "scope", "required": True},
                ],
            ) as session:
                result = session.propose_files({
                    "apps/web/index.html": "<!doctype html>\n",
                    "apps/web/app.js": "console.log('dashboard');\n",
                })
                self.assertEqual(result["decision"], "finish")
            self.assertEqual(Path(root, "apps/web/index.html").read_text(), "<!doctype html>\n")
            self.assertEqual(Path(root, "apps/web/app.js").read_text(), "console.log('dashboard');\n")


if __name__ == "__main__":
    unittest.main()