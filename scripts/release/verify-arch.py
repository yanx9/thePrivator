"""Exercise the Python runtime extracted from the Arch package."""
import json
from pathlib import Path
import subprocess
import sys

result = subprocess.run([str(Path(sys.argv[1]).resolve())], input=json.dumps({
    'id': 'arch-package-health', 'method': 'health.status', 'params': {},
}) + '\n', capture_output=True, text=True, check=True, timeout=30)
response = json.loads(result.stdout)
assert response['ok'], 'Packaged Arch sidecar health failed'
assert response['result']['build']['frozen'], 'Expected the packaged Python runtime'
print('Arch package: application libraries resolved; packaged sidecar health passed')
