# Sidecar tests

Run the Python suite from the repository root:

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -q
```

The suite covers the NDJSON protocol, diagnostics, profile storage and legacy
import, browser lifecycle, fingerprints, proxies, cookies, synchronization,
and the local automation API. Tests use temporary stores and local fixtures;
some require permission to start processes and bind local sockets.

Frontend and Rust checks:

```bash
npm test -- --run
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

The frontend verification scripts also invoke Python. Set `PYTHON` to the
project virtual environment executable if `python3` uses another environment.
See the root README for verification of the packaged sidecar.
