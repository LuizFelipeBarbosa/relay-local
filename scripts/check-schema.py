#!/usr/bin/env python3
"""Validate shared conformance fixtures using JSON Schema Draft 2020-12."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent.parent
schema = json.loads((root / 'protocol/schema.json').read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
fixtures = json.loads((root / 'docs/protocol-examples.json').read_text())
for message in fixtures['valid']:
    validator.validate(message)
for message in fixtures['invalid']:
    assert not validator.is_valid(message), f'Invalid {message["type"]} message was accepted'
print(f'PASS JSON Schema: {len(fixtures["valid"])} valid, {len(fixtures["invalid"])} invalid fixtures')
