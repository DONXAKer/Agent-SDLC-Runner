# Guided process fixture

The templates are a byte-for-byte snapshot of `agent-sdlc/templates`, pinned by
`templates.json`. They include the independent acceptance section that was absent
from the legacy simulator fixture. Tests detect drift against a configured external
methodology; they still verify snapshot hashes when that repository is unavailable.

The full-flow scenario uses the actual Run, guided executors and approval policy.
Model responses are bounded fixture data, not predictions of a live model. An
independently prepared Docker suite rejects the original source before implementation
and cannot be changed by candidate code. Separate reviewer and writer routes test
the provenance of claim judgments; no human operator signature is inferred from PASS.
